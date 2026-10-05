import { userInfo } from 'node:os';
import { ErrorRegistry, loadConfig, inspectProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { FileInstallationIdentityStore, FileProjectIdentityStore, localInstallationBindingSource, registerProviderConfig, readLocalOsIdentity, verifyLocalPeerIdentity, type LocalPeerIdentity } from '#adapters/index.js';
import { policySchema, type InstallationIdentityChoice } from '#domain/index.js';
import { InstallationIdentityError, ProjectIdentityError, PolicyAuthorizationError, type ScopeAccess } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { resolveConfiguredScopeMembership } from './registry.js';
/** Membership precedes identity bootstrap; only write admission pins scopes. Authentication/policy precede the ledger locator. */
export const loadConfiguredScopeContext = async (projectRoot: string, scopeId: string, options: ConfigLoadOptions, access: ScopeAccess) => loadScopeContext(projectRoot, scopeId, options, readLocalOsIdentity(), access);
export const loadConfiguredPeerScopeContext = async (projectRoot: string, scopeId: string, options: ConfigLoadOptions, peer: LocalPeerIdentity, access: ScopeAccess) => loadScopeContext(projectRoot, scopeId, options, verifyLocalPeerIdentity(peer), access);
async function loadScopeContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions, identity: ReturnType<typeof readLocalOsIdentity>, access: ScopeAccess) {
  registerProviderConfig(); const config = await loadConfig(projectRoot, { ...options, heal: false }); const layout = config.productLayout;
  let document; try { document = policySchema.parse(await createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes).load()); }
  catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
  const scopeIds = await resolveConfiguredScopeMembership(config, document, identity, [scopeId], 'read'), principal = Object.freeze({ ...identity, scopeIds });
  const installation = await accessIdentity(new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation.identityProbe), access);
  if (access === 'write') await resolveConfiguredScopeMembership(config, document, identity, [scopeId], access);
  const project = await accessIdentity(new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs), access);
  const installationId = installation.status === 'available' ? installation.value.installationId : null; const projectId = project.status === 'available' ? project.value.projectId : null;
  return Object.freeze({ config, layout, document, principal, projectId, installationId, identity: Object.freeze({ installation, project }),
    path: () => inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']) });
}
async function accessIdentity<T extends { readonly status: string; readonly reason?: string }>(store: { read(): Promise<T>; loadOrCreate(): Promise<unknown> }, access: ScopeAccess) {
  return readIdentity(async () => {
    const current = await store.read();
    if (access === 'write' && current.status === 'unavailable' && current.reason === 'not-created') {
      await store.loadOrCreate(); return store.read();
    }
    return current;
  });
}
async function readIdentity<T>(read: () => Promise<T>) {
  try { return await read(); }
  catch (error) {
    if (error instanceof ProjectIdentityError || error instanceof InstallationIdentityError) throw ErrorRegistry.createError(error.code);
    throw error;
  }
}
export async function loadConfiguredProjectIdentity(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  return accessIdentity(new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs), 'read');
}
export async function loadConfiguredInstallationIdentity(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  return accessIdentity(new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs, undefined, config.installation.identityProbe), 'read');
}
/** Doctor-only, read-soft: whether this host can bind the installation identity to the machine (the product's own capture; nothing is written). */
export async function inspectConfiguredInstallationBinding(projectRoot: string, options: ConfigLoadOptions = {}): Promise<{ readonly capability: 'supported' | 'unsupported' } | null> {
  try {
    const config = await loadConfig(projectRoot, { ...options, heal: false });
    const binding = await localInstallationBindingSource(config.productLayout, config.installation.identityProbe).capture();
    return { capability: 'status' in binding ? 'unsupported' : 'supported' };
  } catch { return null; }
}
/** Local bootstrap-metadata consent, under existing OS ownership guards; no policy or ledger authority is granted. */
export async function resolveConfiguredInstallationIdentity(projectRoot: string, choice: InstallationIdentityChoice, options: ConfigLoadOptions = {}) {
  const principal = readLocalOsIdentity(), config = await loadConfig(projectRoot, { ...options, heal: false });
  return readIdentity(() => new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs, undefined, config.installation.identityProbe)
    .resolveRelocation(choice, { issuer: principal.issuer, subject: principal.subject }));
}
/** Interactive session startup shares the existing managed-write principal, scope and policy admission. */
export async function ensureConfiguredTerminalIdentity(root: string, scopeId: string, options: ConfigLoadOptions) {
  registerProviderConfig(); const observed = await loadConfiguredInstallationIdentity(root, options);
  if (observed.status === 'unavailable' && observed.reason === 'unsupported') throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
  const { installationId, projectId } = await loadConfiguredScopeContext(root, scopeId, options, 'write');
  if (!installationId) throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
  if (!projectId) throw ErrorRegistry.createError('PROJECT_IDENTITY_UNAVAILABLE');
  return Object.freeze({ installationId, projectId });
}
