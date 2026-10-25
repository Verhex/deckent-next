import { encodeCommandProjection, isMcpPrincipal, policyDeclaredScopes, type McpCapabilityGroup } from '#domain/index.js';
import { sha256 } from '#platform/index.js';

export const mcpCapabilityNamespace = (group: McpCapabilityGroup, scopeId: string, actor: { readonly issuer: string; readonly subject: string }) =>
  sha256(encodeCommandProjection('mcp-capability-id:1', { group: group.id, scopeId, actor })).slice(0, 20);


/** Policy-declared read scopes for a person; selecting one grants no authority. */
export function mcpCapabilityScopeCandidates(document: unknown, actor: { readonly issuer: string; readonly subject: string }): readonly string[] {
  if (isMcpPrincipal(actor)) throw new Error('MCP_CAPABILITY_OWNER_REQUIRED');
  return policyDeclaredScopes(document);
}
