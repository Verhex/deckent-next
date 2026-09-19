import { userInfo } from 'node:os';
import { loadConfig, inspectProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, readLocalOsIdentity, verifyLocalPeerIdentity, type LocalPeerIdentity } from '#adapters/index.js';
import { policySchema } from '#domain/index.js';
import { PolicyAuthorizationError, resolvePolicyScopeMembership } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
/** One fresh local config/identity/policy snapshot per request. No ledger access or grant here:
 * the caller's application authenticates/authorizes before invoking the deferred ledger locator.
 */
export async function loadConfiguredScopeContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions) {
  return loadScopeContext(projectRoot, scopeId, options, readLocalOsIdentity());
}
/** Runtime peer verification precedes config/policy access. Scope membership still belongs to current policy. */
export async function loadConfiguredPeerScopeContext(projectRoot: string, scopeId: string,
  options: ConfigLoadOptions, peer: LocalPeerIdentity) {
  return loadScopeContext(projectRoot, scopeId, options, verifyLocalPeerIdentity(peer));
}
async function loadScopeContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions,
  identity: ReturnType<typeof readLocalOsIdentity>) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false }); const layout = config.productLayout;
  let document;
  try { document = policySchema.parse(await createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes).load()); }
  catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
  const scopeIds = resolvePolicyScopeMembership(document, identity, [scopeId]);
  if (!scopeIds.length) throw new PolicyAuthorizationError('POLICY_DENIED');
  const principal = Object.freeze({ ...identity, scopeIds });
  return Object.freeze({ config, layout, document, principal,
    path: () => inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']),
  });
}
