import { policyResources } from './vocabulary.js';

/**
 * MCP trust → permission (owner 2026-10-07: Jev 8e908338 K1, Jev 04f75210 authority kind, Jev 71eeb4ab effect): the trust approval of an MCP
 * server also writes the approver's OWN policy grant for that server — `mcp-server`/`invoke` on its registry name, which covers exactly its pinned
 * tools — in the server's scope (project/local: the scope id; user: every scope of this person). The effect is `require-approval` +
 * `modeEligible`: standart asks every call, full-auto lowers it (audited), full access runs it; the `mcp-floor` cell still always asks.
 * Pure: the `policy.administer` change that adds (replacing this server's earlier grant) or removes it. The id carries the caller's digest of
 * (server scope, server name, person, scope id), so a re-approval replaces exactly its own rule and never another server's or person's.
 */
export const MCP_GRANT_PREFIX = 'mcp-';
export const isMcpGrantId = (id: string) => id.startsWith(MCP_GRANT_PREFIX);
/** The rule id of one server's grant. */
export const mcpGrantRuleIds = (digest: string) => Object.freeze([`${MCP_GRANT_PREFIX}${digest}-server`] as const);

export function mcpToolGrantChange(input: { readonly digest: string; readonly principal: { readonly issuer: string; readonly subject: string };
  readonly scopes: readonly string[] | 'all'; readonly server: string; readonly replaces: readonly string[] }) {
  const [id] = mcpGrantRuleIds(input.digest);
  const grant = Object.freeze({ id, effect: 'require-approval' as const, modeEligible: true, actions: Object.freeze([policyResources.mcpServer.actions[0]]),
    scopes: input.scopes === 'all' ? 'all' as const : Object.freeze([...input.scopes]),
    principals: Object.freeze([Object.freeze({ issuer: input.principal.issuer, subject: input.principal.subject })]),
    resource: Object.freeze({ kind: policyResources.mcpServer.kind, ids: Object.freeze([input.server]) }) });
  return Object.freeze({ schemaVersion: 1 as const, changes: Object.freeze([...input.replaces.map(replaced => Object.freeze({ kind: 'grant.remove' as const, id: replaced })),
    Object.freeze({ kind: 'grant.add' as const, grant })]) });
}
export const mcpToolGrantRevokeChange = (ids: readonly string[]) =>
  Object.freeze({ schemaVersion: 1 as const, changes: Object.freeze(ids.map(id => Object.freeze({ kind: 'grant.remove' as const, id }))) });
