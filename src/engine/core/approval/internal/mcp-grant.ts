import { authorityDocuments, delegationWithin, mcpGrantRuleIds, mcpToolGrantChange, mcpToolGrantRevokeChange, planPolicyChange, policySchema } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { administerOwnPolicyChange, type PersistentStandingDependencies } from './standing.js';

/** Why a trusted server's tools got no grant: the approver does not hold this authority in that scope (`delegation`), the policy cannot
 * carry it (`unsupported`: v1 or unreadable), the change did not settle, or another refusal (its code). Trust itself is recorded either way. */
export type McpToolGrantOutcome = { readonly status: 'granted' | 'revoked' | 'none' } | { readonly status: 'refused'; readonly reason: string };
export interface McpToolGrantTarget { readonly scope: 'managed' | 'local' | 'project' | 'user'; readonly name: string }

/**
 * MCP trust → permission (L1 K1, Jev 8e908338): the approver's own grant for exactly a server's pinned tools, written and removed only through
 * `policy.administer@1` (the same chain, delegation bound, `authority-change` audit and archive as every governed policy change). It is probed
 * first with the delegation bound, so a person without that authority gets their trust recorded and a typed reason, never a half-written
 * policy. A user-scope server's grant covers every scope of this person; any other, the request's scope. Pin drift needs no policy change:
 * a drifted tool is never offered and its send is refused (`pin-revoked`) until re-approval re-pins it and replaces this grant.
 */
export class McpToolGrants {
  constructor(private readonly deps: Pick<PersistentStandingDependencies, 'administration' | 'approve' | 'policy'>, private readonly operationId: string) {}
  private digest(scopeId: string, principal: { readonly issuer: string; readonly subject: string }, server: McpToolGrantTarget) {
    return sha256(`mcp-tool-grant:1\0${server.scope}\0${server.name}\0${principal.issuer}\0${principal.subject}\0${server.scope === 'user' ? '*' : scopeId}`).slice(0, 24);
  }
  private async snapshot() {
    const policy = policySchema.parse(await this.deps.policy.load());
    return policy.schemaVersion === 2 ? policy : null;
  }
  async grant(input: { readonly scopeId: string; readonly principal: { readonly issuer: string; readonly subject: string }; readonly server: McpToolGrantTarget;
    readonly tools: readonly string[]; readonly reason: string }): Promise<McpToolGrantOutcome> {
    const policy = await this.snapshot().catch(() => null);
    if (!policy) return { status: 'refused', reason: 'unsupported' };
    const digest = this.digest(input.scopeId, input.principal, input.server), ids = mcpGrantRuleIds(digest), held = ids.filter(id => policy.grants.some(grant => grant.id === id));
    if (!input.tools.length) return held.length ? this.revoke(input) : { status: 'none' };
    const change = mcpToolGrantChange({ digest, principal: input.principal, scopes: input.server.scope === 'user' ? 'all' : [input.scopeId], tools: input.tools,
      operationId: this.operationId, replaces: held });
    try {
      const files = authorityDocuments(policy);
      if (!delegationWithin(policy, input.principal, planPolicyChange(files.policy, files.bindings, change).touched).ok) return { status: 'refused', reason: 'delegation' };
      await administerOwnPolicyChange(this.deps, { scopeId: input.scopeId, principal: input.principal, change, tag: `grant:${digest}:${input.tools.join(',')}`, reason: input.reason,
        revision: policy.revision, kind: 'mcp-tool-grant' });
      return { status: 'granted' };
    } catch (error) { return { status: 'refused', reason: refusal(error) }; }
  }
  /** Removes this person's grant of the server (trust revoked, reset, declined or the entry removed); nothing to remove is `none`. */
  async revoke(input: { readonly scopeId: string; readonly principal: { readonly issuer: string; readonly subject: string }; readonly server: McpToolGrantTarget;
    readonly reason: string }): Promise<McpToolGrantOutcome> {
    const policy = await this.snapshot().catch(() => null);
    if (!policy) return { status: 'none' };
    const digest = this.digest(input.scopeId, input.principal, input.server), held = mcpGrantRuleIds(digest).filter(id => policy.grants.some(grant => grant.id === id));
    if (!held.length) return { status: 'none' };
    try {
      await administerOwnPolicyChange(this.deps, { scopeId: input.scopeId, principal: input.principal, change: mcpToolGrantRevokeChange(held), tag: `revoke:${digest}`, reason: input.reason,
        revision: policy.revision, kind: 'mcp-tool-grant' });
      return { status: 'revoked' };
    } catch (error) { return { status: 'refused', reason: refusal(error) }; }
  }
}
const refusal = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'POLICY_DELEGATION_EXCEEDS' ? 'delegation' : error instanceof Error && error.message === 'NOT_SETTLED' ? 'not-settled' : typeof code === 'string' ? code : 'failed';
};
