import { timedAsync } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { userInfo } from 'node:os';
import { ErrorRegistry, inspectProductFile, type ConfigLoadOptions, type ProductLayout, type ResolvedConfig } from '#platform/index.js';
import { attachmentLifecycle, FileProjectAttachmentStore, openSqliteAuditStore, openReadOnlyAuditStore, openLocalIntegrityAuthority, FileInstallationIdentityStore, FileProjectIdentityStore, localInstallationBindingSource, inspectFilesystemIdentity, readLocalOsIdentity, verifyLocalPeerIdentity, type LocalPeerIdentity } from '#adapters/index.js';
import { type InstallationIdentityChoice } from '#domain/index.js';
import { AuditApplication, ProjectAttachmentError, InstallationIdentityError, ProjectIdentityError, PolicyAuthorizationError, type ScopeAccess } from '#engine/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { configuredInstallationProjectContext } from './installation-context.js';
import { resolveConfiguredScopeMembership } from './registry.js';
import { admitInstallationRebinding, plainMacosRebinding } from './rebind.js';
/** Membership precedes identity bootstrap; only write admission pins scopes. Authentication/policy precede the ledger locator. */
// The local OS identity is read after the policy loads: unsupported policy custody (native Windows) refuses POLICY_UNAVAILABLE before
// any identity access (PLATFORM-TEMIZLIK). A socket peer is still verified first, so an unauthenticated caller learns nothing about policy.
type ScopeReadInputs = Readonly<{ config: ResolvedConfig; document: Awaited<ReturnType<ReturnType<typeof contextPolicySource>['load']>>;
  inspectSource: NonNullable<Parameters<typeof configuredInstallationProjectContext>[4]> }>;
export const loadConfiguredScopeContext = async (projectRoot: string, scopeId: string, options: ConfigLoadOptions, access: ScopeAccess, inspected?: ScopeReadInputs) => timedScopeContext(projectRoot, scopeId, options, readLocalOsIdentity, access, inspected);
export const loadConfiguredPeerScopeContext = async (projectRoot: string, scopeId: string, options: ConfigLoadOptions, peer: LocalPeerIdentity, access: ScopeAccess) => {
  const verified = verifyLocalPeerIdentity(peer);
  return timedScopeContext(projectRoot, scopeId, options, () => verified, access);
};
async function loadScopeContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions, readIdentity: () => ReturnType<typeof readLocalOsIdentity>, access: ScopeAccess, inspected?: ScopeReadInputs) {
  const reading = access === 'read' ? inspected : undefined;
  const config = reading?.config ?? await loadComposedConfig(projectRoot, { ...options, heal: false }); const layout = config.productLayout, ownerUid = userInfo().uid;
  let document; try { document = reading?.document ?? await contextPolicySource({ layout, config, ownerUid }).load(); }
  catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
  const identity = readIdentity();
  const scopeIds = await resolveConfiguredScopeMembership(config, document, identity, [scopeId], 'read'), principal = Object.freeze({ ...identity, scopeIds });
  const installationContext = await readBootstrapIdentity(() => configuredInstallationProjectContext(config, options, scopeId, { issuer: identity.issuer, subject: identity.subject }, reading?.inspectSource));
  const installation = installationContext.kind === 'legacy' ? await accessIdentity(new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation), access) : installationContext.identity;
  if (access === 'write') await resolveConfiguredScopeMembership(config, document, identity, [scopeId], access);
  const project = await accessIdentity(new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs), access);
  const installationId = installation.status === 'available' ? installation.value.installationId : null; const projectId = project.status === 'available' ? project.value.projectId : null;
  return Object.freeze({ config, layout, ownerUid, document, principal, projectId, installationId, identity: Object.freeze({ installation, project }),
    path: () => inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']) });
}
/** Key creation and ledger access are independent: producers may require an existing key; observers open read-only without creating one. */
export async function withScopeAudit<T>(context: { path(): Promise<string>; readonly layout: ProductLayout; readonly config: Pick<ResolvedConfig, 'storage' | 'approvals'> },
  work: (audit: AuditApplication) => T | Promise<T>, createKey = true, access: ScopeAccess = 'write'): Promise<T> {
  const path = await context.path(), store = access === 'read' ? await openReadOnlyAuditStore(path, context.config.storage.sqlite) : await openSqliteAuditStore(path, context.config.storage.sqlite, 'forbid');
  try { return await work(new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, access === 'write' && createKey))); } finally { store.close(); }
}
async function accessIdentity<T extends { readonly status: string; readonly reason?: string; readonly pendingWrite?: true }>(store: { read(): Promise<T>; loadOrCreate(): Promise<unknown> }, access: ScopeAccess) {
  return readBootstrapIdentity(async () => {
    const current = await store.read();
    // Write admission takes the store's write path for first use and for a pending binding transition (weak bind, strengthen, required machine binding).
    if (access === 'write' && ((current.status === 'unavailable' && current.reason === 'not-created') || current.pendingWrite)) {
      await store.loadOrCreate(); return store.read();
    }
    return current;
  });
}
async function readBootstrapIdentity<T>(read: () => Promise<T>, identityChoice?: InstallationIdentityChoice) {
  try { return await read(); }
  catch (error) {
    if (error instanceof ProjectAttachmentError || error instanceof ProjectIdentityError || error instanceof InstallationIdentityError) throw ErrorRegistry.createError(error.code, {
      params: error.code === 'PROJECT_ATTACHMENT_SOURCE_REGISTERED' && identityChoice ? { identityChoice }
        : error.code === 'INSTALLATION_IDENTITY_REBIND_REQUIRED' ? { platform: process.platform } : {} });
    throw error;
  }
}
export async function loadConfiguredProjectIdentity(projectRoot: string, options: ConfigLoadOptions = {}, access: ScopeAccess = 'read') { // 'write': first-use publication
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false });
  return accessIdentity(new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs), access);
}
export async function loadConfiguredInstallationIdentity(projectRoot: string, options: ConfigLoadOptions = {}, inspected?: Pick<ScopeReadInputs, 'config' | 'inspectSource'>) {
  const config = inspected?.config ?? await loadComposedConfig(projectRoot, { ...options, heal: false });
  return readBootstrapIdentity(async () => (await configuredInstallationProjectContext(config, options, undefined, undefined, inspected?.inspectSource)).identity);
}
/** Doctor-only, read-soft: the binding strength and source this host reaches now (the product's own capture; nothing is written, no value shown). */
type InstallationBindingInspection = { readonly capability: 'supported' | 'unsupported' | 'source-invalid';
  readonly strength: 'machine' | 'weak' | null; readonly source: 'configured' | 'platform' | 'location' | null; readonly required: boolean;
  readonly filesystemIdentity: Readonly<{ status: 'available'; kind: string } | { status: 'unavailable'; reason: string }> };
export async function inspectConfiguredInstallationBinding(projectRoot: string, options: ConfigLoadOptions = {}): Promise<InstallationBindingInspection | null> {
  let config;
  try { config = await loadComposedConfig(projectRoot, { ...options, heal: false }); } catch { return null; }
  const required = config.installation.requireMachineBinding;
  const observed = await inspectFilesystemIdentity(config.productLayout.root);
  const filesystemIdentity = observed.status === 'available' ? { status: 'available' as const, kind: observed.identity.kind } : observed;
  try {
    // The capability is machine-level: probe against the project directory, which exists before `.deckent` is initialized.
    const binding = await localInstallationBindingSource({ ...config.productLayout, root: config.projectRoot }, config.installation).capture();
    return 'status' in binding ? { capability: 'unsupported', strength: null, source: null, required, filesystemIdentity }
      : { capability: 'supported', strength: binding.strength, source: binding.source, required, filesystemIdentity };
  } catch (error) {
    if (error instanceof InstallationIdentityError && error.code === 'INSTALLATION_IDENTITY_SOURCE_INVALID') return { capability: 'source-invalid', strength: null, source: 'configured', required, filesystemIdentity };
    return null;
  }
}
/** Local bootstrap-metadata consent, under existing OS ownership guards; no policy or ledger authority is granted. */
export async function resolveConfiguredInstallationIdentity(projectRoot: string, choice: InstallationIdentityChoice, options: ConfigLoadOptions = {}) {
  const { issuer, subject } = readLocalOsIdentity(), principal = { issuer, subject }, config = await loadComposedConfig(projectRoot, { ...options, heal: false });
  return readBootstrapIdentity(async () => {
    const lifecycle = attachmentLifecycle(config, options);
    await lifecycle.assert();
    const store = new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs, undefined, config.installation);
    if (choice === 'new') return store.resolveRelocation({ choice }, principal);
    const admission = await admitInstallationRebinding(config, options, store, principal);
    const keep = async () => {
      const registration = await new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs).registration();
      const result = await store.resolveRelocation({ choice, admission }, principal);
      return { ...result, ...(registration?.source.installationId === result.installationId && registration.source.projectRoot !== config.projectRoot
        ? { attachmentRecordsUnreconciled: true as const } : {}) };
    };
    // Only the plain-project exception needs this hold; open-class and witnessed/rule paths keep their existing dependencies.
    return admission.basis === 'macos-plain' ? lifecycle.hold(async () => {
      if (!await plainMacosRebinding(config, options, (await store.inspectRebinding()).installationId)) throw new InstallationIdentityError('INSTALLATION_IDENTITY_REBIND_REQUIRED');
      return keep();
    }) : keep();
  }, choice);
}
/** Interactive session startup shares the existing managed-write principal, scope and policy admission. */
export async function ensureConfiguredTerminalIdentity(root: string, scopeId: string, options: ConfigLoadOptions) {
  const observed = await loadConfiguredInstallationIdentity(root, options);
  if (observed.status === 'unavailable' && observed.reason === 'unsupported') throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
  const { installationId, projectId } = await loadConfiguredScopeContext(root, scopeId, options, 'write');
  if (!installationId) throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
  if (!projectId) throw ErrorRegistry.createError('PROJECT_IDENTITY_UNAVAILABLE');
  return Object.freeze({ installationId, projectId });
}

const timedScopeContext = timedAsync('scope-context', loadScopeContext);
