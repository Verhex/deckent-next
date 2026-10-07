import { policyResources } from './vocabulary.js';

/**
 * MCP trust → permission (L1 MCP-CORE K1, Jev 8e908338): the owner's trust approval of an MCP server also writes the approver's OWN policy grant for
 * exactly the pinned tools — `agent-tool`/`invoke` on their wire names and `operation`/`execute` on the Core MCP call operation, the two sides
 * `decideAgentToolCall` evaluates — in the server's scope (project/local: the scope id; user: every scope of this person). Pure: the
 * `policy.administer` change that adds (replacing this server's earlier grant) or removes it. The ids carry the caller's digest of
 * (server scope, server name, person, scope id), so a re-approval replaces exactly its own rules and never another server's or person's.
 */
export const MCP_GRANT_PREFIX = 'mcp-';
export const isMcpGrantId = (id: string) => id.startsWith(MCP_GRANT_PREFIX);
/** The rule ids of one server's grant (the tools side and the operation side). */
export const mcpGrantRuleIds = (digest: string) => Object.freeze([`${MCP_GRANT_PREFIX}${digest}-tools`, `${MCP_GRANT_PREFIX}${digest}-call`] as const);

export function mcpToolGrantChange(input: { readonly digest: string; readonly principal: { readonly issuer: string; readonly subject: string };
  readonly scopes: readonly string[] | 'all'; readonly tools: readonly string[]; readonly operationId: string; readonly replaces: readonly string[] }) {
  const [tools, call] = mcpGrantRuleIds(input.digest), principals = Object.freeze([Object.freeze({ issuer: input.principal.issuer, subject: input.principal.subject })]);
  const scopes = input.scopes === 'all' ? 'all' as const : Object.freeze([...input.scopes]);
  const rule = (id: string, kind: string, action: string, ids: readonly string[]) => Object.freeze({ kind: 'grant.add' as const, grant: Object.freeze({ id, effect: 'allow' as const,
    actions: Object.freeze([action]), scopes, principals, resource: Object.freeze({ kind, ids: Object.freeze([...ids]) }) }) });
  return Object.freeze({ schemaVersion: 1 as const, changes: Object.freeze([...input.replaces.map(id => Object.freeze({ kind: 'grant.remove' as const, id })),
    rule(tools, policyResources.agentTool.kind, 'invoke', input.tools), rule(call, policyResources.operation.kind, 'execute', [input.operationId])]) });
}
export const mcpToolGrantRevokeChange = (ids: readonly string[]) =>
  Object.freeze({ schemaVersion: 1 as const, changes: Object.freeze(ids.map(id => Object.freeze({ kind: 'grant.remove' as const, id }))) });
