import { encodeCommandProjection, isMcpPrincipal, policyDeclaredScopes, mcpCapabilityIdChunks, mcpCapabilityRules, mcpPrincipalRef, principalGrants, sameMcpCapabilityRule, policySchema, type PolicyGrant, type VerifiedPrincipal, type McpCapabilityGroup } from '#domain/index.js';
import { sha256 } from '#platform/index.js';

export const mcpCapabilityNamespace = (group: McpCapabilityGroup, scopeId: string, actor: { readonly issuer: string; readonly subject: string }) =>
  sha256(encodeCommandProjection('mcp-capability-id:1', { group: group.id, scopeId, actor })).slice(0, 20);


/** Policy-declared read scopes for a person; selecting one grants no authority. */
export function mcpCapabilityScopeCandidates(document: unknown, actor: { readonly issuer: string; readonly subject: string }): readonly string[] {
  if (isMcpPrincipal(actor)) throw new Error('MCP_CAPABILITY_OWNER_REQUIRED');
  return policyDeclaredScopes(document);
}

export function resolvedMcpCapabilityRules(group: McpCapabilityGroup, scopeId: string, principal: VerifiedPrincipal, policy: ReturnType<typeof policySchema.parse>, workTargetId: string | null, operationIds: readonly string[]) {
    const actor = mcpPrincipalRef(principal);
    const namespace = mcpCapabilityNamespace(group, scopeId, actor);
    const cells = group.cells.flatMap(cell => {
      if (cell.source === 'registered-operations') return mcpCapabilityIdChunks(operationIds).map(ids => ({ ...cell, resource: { ...cell.resource, ids } }));
      if (cell.source === 'configured-target') return workTargetId ? [{ ...cell, resource: { ...cell.resource, ids: [workTargetId] } }] : [];
      if (cell.source !== 'owned-pools') return [cell];
      const grants = principalGrants(policy, principal).filter(rule => rule.effect === 'allow' && rule.resource.kind === cell.resource.kind
        && (rule.principals === 'all' || rule.principals.some(person => person.issuer === principal.issuer && person.subject === principal.subject))
        && (rule.scopes === 'all' || rule.scopes.includes(scopeId)) && cell.actions.every(action => rule.actions === 'all' || rule.actions.includes(action)));
      const ids = grants.some(rule => rule.resource.ids === 'all') ? 'all' as const : [...new Set(grants.flatMap(rule => rule.resource.ids === 'all' ? [] : rule.resource.ids))].sort();
      // No held pool authority: keep the required cell visible and let I2 refuse, rather than pretend the group works.
      return [{ ...cell, resource: { ...cell.resource, ids: ids.length ? ids : 'all' as const } }];
    });
    return mcpCapabilityRules({ ...group, cells }, scopeId, actor, namespace, text => sha256(text).slice(0, 16));
  }
  /** Known current and superseded shapes only; a hand-edited owned id is a conflict, never silently deleted. */
export function ownedMcpCapabilityRules(group: McpCapabilityGroup, scopeId: string, principal: VerifiedPrincipal, policy: ReturnType<typeof policySchema.parse>, current: readonly PolicyGrant[]) {
    const actor = mcpPrincipalRef(principal), namespace = mcpCapabilityNamespace(group, scopeId, actor);
    const shapes = [group.cells, ...group.supersedes.map(earlier => earlier.cells)];
    const prefix = `mcp-cap-${namespace}-`;
    const held = policy.grants.filter(rule => rule.id.startsWith(prefix));
    const known = (rule: PolicyGrant) => shapes.some(cells => cells.some(cell => {
      const id = `${prefix}${cell.id}`;
      if (rule.id !== id && !(cell.source !== 'literal' && rule.id === `${id}-${sha256(JSON.stringify(rule.resource.ids)).slice(0, 16)}`)) return false;
      const candidate = mcpCapabilityRules({ ...group, cells: [{ ...cell, resource: { ...cell.resource,
        ids: cell.source === 'literal' ? cell.resource.ids : rule.resource.ids } }] }, scopeId, actor, namespace)[0]!;
      return sameMcpCapabilityRule(rule, { ...candidate, id: rule.id });
    }));
    return { held, conflict: held.some(rule => !known(rule)), earlier: held.some(rule => !current.some(want => sameMcpCapabilityRule(rule, want))) };
  }
