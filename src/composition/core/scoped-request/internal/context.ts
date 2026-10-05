import { userInfo } from 'node:os';
import { ErrorRegistry, loadConfig, inspectProductFile, type ResolvedConfig, type ConfigLoadOptions } from '#platform/index.js';
import { FileProjectIdentityStore, registerProviderConfig, readLocalOsIdentity, verifyLocalPeerIdentity, type LocalPeerIdentity } from '#adapters/index.js';
import { policySchema } from '#domain/index.js';
import { ProjectIdentityError, type ProjectIdentityStore, PolicyAuthorizationError, type ScopeAccess } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { resolveConfiguredScopeMembership } from './registry.js';
/** Fresh config/policy/identity. Trusted membership precedes project bootstrap; only write admission pins scopes.
 * Queries never write ledger pins (H34 S1, Astra 2126 R1). Bootstrap grants no authority.
 * Application authentication/authorization still precedes the deferred ledger locator. */
export const loadConfiguredScopeContext = async (projectRoot: string, scopeId: string, options: ConfigLoadOptions, access: ScopeAccess) =>
  loadScopeContext(projectRoot, scopeId, options, readLocalOsIdentity(), access);
/** Runtime peer verification precedes config/policy access. Scope membership still belongs to current policy. */
export const loadConfiguredPeerScopeContext = async (projectRoot: string, scopeId: string, options: ConfigLoadOptions, peer: LocalPeerIdentity, access: ScopeAccess) =>
  loadScopeContext(projectRoot, scopeId, options, verifyLocalPeerIdentity(peer), access);
async function loadScopeContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions,
  identity: ReturnType<typeof readLocalOsIdentity>, access: ScopeAccess) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false }); const layout = config.productLayout;
  let document;
  try { document = policySchema.parse(await createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes).load()); }
  catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
  const scopeIds = await resolveConfiguredScopeMembership(config, document, identity, [scopeId], access);
  const principal = Object.freeze({ ...identity, scopeIds });
  const { projectId } = await loadProjectIdentityForConfig(config);
  return Object.freeze({ config, layout, document, principal, projectId,
    path: () => inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']),
  });
}
async function loadProjectIdentityForConfig(config: ResolvedConfig) {
  const store: ProjectIdentityStore = new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs);
  try { return await store.loadOrCreate(); }
  catch (error) {
    if (error instanceof ProjectIdentityError) throw ErrorRegistry.createError(error.code);
    throw error;
  }
}
export async function loadConfiguredProjectIdentity(projectRoot: string, options: ConfigLoadOptions = {}) {
  return loadProjectIdentityForConfig(await loadConfig(projectRoot, { ...options, heal: false }));
}
