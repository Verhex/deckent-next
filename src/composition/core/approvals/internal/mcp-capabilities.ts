import { userInfo } from 'node:os';
import type { McpCapabilityRequest } from '#domain/index.js';
import { McpCapabilities, mcpCapabilityRegistry, mcpCapabilityScopeCandidates } from '#engine/index.js';
import { attestLocalInteractiveTerminal, localPrincipalPeer, readLocalOsIdentity, selectWorkTarget } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { resolveConfiguredScopeMembership } from '#composition/core/scoped-request/index.js';
import { withPolicyAdministration } from './standing.js';

/** Existing policy-declared scopes, filtered through the same company membership port as every request. Nothing is created. */
export async function listConfiguredMcpCapabilityScopes(root: string, options: ConfigLoadOptions = {}): Promise<readonly string[]> {
  const config = await loadComposedConfig(root, { ...options, heal: false }), actor = readLocalOsIdentity();
  const document = await createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes).load();
  const candidates = mcpCapabilityScopeCandidates(document, actor);
  return candidates.length ? resolveConfiguredScopeMembership(config, document, actor, candidates, 'read') : [];
}
async function validateScope(root: string, scopeId: string, options: ConfigLoadOptions) {
  if (!(await listConfiguredMcpCapabilityScopes(root, options)).includes(scopeId)) throw ErrorRegistry.createError('SCOPE_UNKNOWN');
}
export async function inspectConfiguredMcpCapabilities(root: string, scopeId: string, options: ConfigLoadOptions = {}) {
  await validateScope(root, scopeId, options);
  const config = await loadComposedConfig(root, { ...options, heal: false }), target = selectWorkTarget(config.execution)?.id ?? null;
  return withPolicyAdministration(root, scopeId, options, 'read', (deps, person) => new McpCapabilities(deps, mcpCapabilityRegistry, target).inspect(scopeId, person));
}
/** Apply is only a reviewed digest selection on an attested terminal. Its subordinate approval and final policy write retain their checks. */
export async function changeConfiguredMcpCapabilities(root: string, input: McpCapabilityRequest, options: ConfigLoadOptions = {}) {
  if (!['grant', 'revoke'].includes(input.action) || !['preview', 'apply'].includes(input.mode)) throw ErrorRegistry.createError('CLI_USAGE');
  if (!mcpCapabilityRegistry.list().some(group => group.id === input.groupId)) throw ErrorRegistry.createError('CLI_USAGE');
  await validateScope(root, input.scopeId, options);
  const config = await loadComposedConfig(root, { ...options, heal: false }), target = selectWorkTarget(config.execution)?.id ?? null;
  if (input.mode === 'apply') {
    if (!input.expect) throw ErrorRegistry.createError('CLI_USAGE');
    const peer = localPrincipalPeer();
    if (!await attestLocalInteractiveTerminal(peer?.pid, peer?.uid)) throw ErrorRegistry.createError('APPROVAL_INTERACTIVE_REQUIRED');
  }
  // Compute under a read-only context first: an invalid digest never bootstraps a ledger, identities or a session.
  const preview = await withPolicyAdministration(root, input.scopeId, options, 'read', (deps, person) => new McpCapabilities(deps, mcpCapabilityRegistry, target).run({ ...input, mode: 'preview' }, person, ''));
  if (input.mode === 'preview' || preview.status !== 'preview') return preview;
  if (input.expect !== preview.digest) return { ...preview, status: 'conflict' as const };
  if (preview.missing.length) return { ...preview, status: 'refused' as const };
  return withPolicyAdministration(root, input.scopeId, options, 'write', (deps, person) => new McpCapabilities(deps, mcpCapabilityRegistry, target).run(input, person, `MCP ${input.action}: ${input.groupId}, ${input.scopeId}`));
}
