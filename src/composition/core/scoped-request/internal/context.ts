import { userInfo } from 'node:os';
import { loadConfig, inspectProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, readLocalOsIdentity, verifyLocalPeerIdentity, type LocalPeerIdentity } from '#adapters/index.js';
import { policySchema } from '#domain/index.js';
import { PolicyAuthorizationError, type ScopeAccess } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { resolveConfiguredScopeMembership } from './registry.js';
/** One fresh local config/identity/policy snapshot per request. The only ledger access here is the scope registry, after a trusted
 * grant exists (H34 S1: fail-closed membership): a lookup, plus — for `write` access (the default) — the insert-only pin of a
 * declared scope at its first admission. Read-only callers pass `read`. The caller's application still authenticates/authorizes
 * before invoking the deferred ledger locator.
 */
export async function loadConfiguredScopeContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions, access: ScopeAccess = 'write') {
  return loadScopeContext(projectRoot, scopeId, options, readLocalOsIdentity(), access);
}
/** Runtime peer verification precedes config/policy access. Scope membership still belongs to current policy. */
export async function loadConfiguredPeerScopeContext(projectRoot: string, scopeId: string,
  options: ConfigLoadOptions, peer: LocalPeerIdentity, access: ScopeAccess = 'write') {
  return loadScopeContext(projectRoot, scopeId, options, verifyLocalPeerIdentity(peer), access);
}
async function loadScopeContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions,
  identity: ReturnType<typeof readLocalOsIdentity>, access: ScopeAccess) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false }); const layout = config.productLayout;
  let document;
  try { document = policySchema.parse(await createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes).load()); }
  catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
  const scopeIds = await resolveConfiguredScopeMembership(config, document, identity, [scopeId], access);
  const principal = Object.freeze({ ...identity, scopeIds });
  return Object.freeze({ config, layout, document, principal,
    path: () => inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']),
  });
}
