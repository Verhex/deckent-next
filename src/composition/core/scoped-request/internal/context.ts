import { userInfo } from 'node:os';
import { ErrorRegistry, loadConfig, inspectProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { FileInstallationIdentityStore, FileProjectIdentityStore, registerProviderConfig, readLocalOsIdentity, verifyLocalPeerIdentity, type LocalPeerIdentity } from '#adapters/index.js';
import { policySchema } from '#domain/index.js';
import { InstallationIdentityError, ProjectIdentityError, PolicyAuthorizationError, type ScopeAccess } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { resolveConfiguredScopeMembership } from './registry.js';
/** Membership precedes identity bootstrap; only write admission pins scopes. Authentication/policy precede the ledger locator. */
export const loadConfiguredScopeContext = async (projectRoot: string, scopeId: string, options: ConfigLoadOptions, access: ScopeAccess) =>
  loadScopeContext(projectRoot, scopeId, options, readLocalOsIdentity(), access);
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
  const { projectId } = await readIdentity(new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs));
  const { installationId } = await readIdentity(new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs));
  return Object.freeze({ config, layout, document, principal, projectId, installationId,
    path: () => inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']) });
}
async function readIdentity<T>(store: { loadOrCreate(): Promise<T> }) {
  try { return await store.loadOrCreate(); }
  catch (error) {
    if (error instanceof ProjectIdentityError || error instanceof InstallationIdentityError) throw ErrorRegistry.createError(error.code);
    throw error;
  }
}
export async function loadConfiguredProjectIdentity(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  return readIdentity(new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs));
}
export async function loadConfiguredInstallationIdentity(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  return readIdentity(new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs));
}
