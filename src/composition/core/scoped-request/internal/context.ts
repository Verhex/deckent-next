import { createHash } from 'node:crypto';
import { timedAsync } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { userInfo } from 'node:os';
import { ErrorRegistry, inspectProductFile, isCodedError, productResourcePath, type ConfigLoadOptions, type ProductLayout, type ResolvedConfig } from '#platform/index.js';
import { attachmentLifecycle, FileProjectAttachmentStore, openSqliteAuditStore, openReadOnlyAuditStore, openLocalIntegrityAuthority, FileInstallationIdentityStore, FileProjectIdentityStore, localInstallationBindingSource, localPrincipalChannel, inspectFilesystemIdentity, readLocalOsIdentity, verifyLocalPeerIdentity, type LocalPeerIdentity } from '#adapters/index.js';
import { type InstallationIdentityChoice } from '#domain/index.js';
import { AuditApplication, ProjectAttachmentError, InstallationIdentityError, ProjectIdentityError, PolicyAuthorizationError,
  sameProjectAttachmentAuthority, type ScopeAccess, type SourceRepairKind } from '#engine/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { configuredInstallationProjectContext, inspectConfiguredInstallationSource } from './installation-context.js';
import { resolveConfiguredScopeMembership } from './registry.js';
import { admitInstallationRebinding, plainMacosRebinding } from './rebind.js';
/** Membership precedes identity bootstrap; only write admission pins scopes. Authentication/policy precede the ledger locator. */
// The local OS identity is read after the policy loads: unsupported policy custody (native Windows) refuses POLICY_UNAVAILABLE before
// any identity access (PLATFORM-TEMIZLIK). A socket peer is still verified first, so an unauthenticated caller learns nothing about policy.
type ScopeReadInputs = Readonly<{ config: ResolvedConfig; document: Awaited<ReturnType<ReturnType<typeof contextPolicySource>['load']>>;
  inspectSource: NonNullable<Parameters<typeof configuredInstallationProjectContext>[4]> }>;
type CheckRunControlLocation = (location: string) => void;
const bindingDigest = (fields: readonly unknown[]) => createHash('sha256').update(JSON.stringify(fields)).digest('hex');
const controlLocation = (config: ResolvedConfig) => bindingDigest([config.projectRoot, config.company.id, config.installation.sharedRegistrationId, config.approvals.keyFile,
  ...(['installationIdentity', 'ledger', 'policy', 'bindings', 'approvals'] as const).map(resource => productResourcePath(config.productLayout, resource))]);
export const loadConfiguredScopeContext = (projectRoot: string, scopeId: string, options: ConfigLoadOptions, access: ScopeAccess, inspected?: ScopeReadInputs, checkLocation?: CheckRunControlLocation) =>
  timedScopeContext(projectRoot, scopeId, options, readLocalOsIdentity, access, inspected, undefined, checkLocation);
export const loadConfiguredPeerScopeContext = async (projectRoot: string, scopeId: string, options: ConfigLoadOptions, peer: LocalPeerIdentity, access: ScopeAccess) => {
  const verified = verifyLocalPeerIdentity(peer);
  return timedScopeContext(projectRoot, scopeId, options, () => verified, access);
};
async function loadScopeContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions, readIdentity: () => ReturnType<typeof readLocalOsIdentity>,
  access: ScopeAccess, inspected?: ScopeReadInputs, onSourceRepair?: (kind: SourceRepairKind) => void, checkLocation?: CheckRunControlLocation) {
  const reading = access === 'read' ? inspected : undefined;
  const config = reading?.config ?? await loadComposedConfig(projectRoot, { ...options, heal: false }); const layout = config.productLayout, ownerUid = userInfo().uid;
  checkLocation?.(controlLocation(config));
  const loadPolicy = async () => {
    try { return await contextPolicySource({ layout, config, ownerUid }).load(); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
  };
  const document = reading?.document ?? await loadPolicy();
  const identity = readIdentity();
  const scopeIds = await resolveConfiguredScopeMembership(config, document, identity, [scopeId], 'read'), principal = Object.freeze({ ...identity, scopeIds });
  let writeAdmitted = false;
  const admitWrite = async (checkpoint?: 'target-publication') => {
    if (writeAdmitted && !checkpoint) return;
    const current = checkpoint === 'target-publication' ? await loadPolicy() : document;
    await resolveConfiguredScopeMembership(config, current, identity, [scopeId], 'write');
    writeAdmitted = true;
  };
  const installationContext = await readBootstrapIdentity(() => configuredInstallationProjectContext(config, options, scopeId,
    { issuer: identity.issuer, subject: identity.subject }, reading?.inspectSource, access === 'write' ? admitWrite : undefined, onSourceRepair));
  const sourceRepaired = writeAdmitted;
  const installationStore = installationContext.kind === 'legacy'
    ? new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation) : null;
  const projectStore = new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs);
  const accessIdentities = async (mode: ScopeAccess) => {
    const observed = installationStore ? await accessIdentity(installationStore, mode) : installationContext.identity;
    let installation = observed;
    if (mode === 'write') {
      await admitWrite();
      if (!sourceRepaired && installationStore && observed.status === 'available' && observed.pendingUpgrade) {
        installation = await readBootstrapIdentity(async () => {
          await installationStore.upgradeAdmittedBinding(observed.value.installationId);
          return installationStore.read();
        });
      }
    }
    return { installation, project: await accessIdentity(projectStore, mode) };
  };
  const { installation, project } = await accessIdentities(access);
  const installationId = installation.status === 'available' ? installation.value.installationId : null; const projectId = project.status === 'available' ? project.value.projectId : null;
  return Object.freeze({ config, layout, installationLayout: installationContext.installationLayout, ownerUid, document, principal, projectId, installationId, identity: Object.freeze({ installation, project }),
    runControlBinding: () => `${controlLocation(config)}:${bindingDigest([installationId, projectId, principal.id, principal.issuer, principal.subject, principal.assurance])}`,
    // Complete write admission on this context's layout, company, policy and principal.
    async admitWrite() { await accessIdentities('write'); },
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
    const registry = new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
    const attached = config.installation.sharedRegistrationId || await registry.attachment();
    if (choice === 'new') return attached ? store.resolveRelocation({ choice }, principal) : store.resolvePlainRelocation({ choice }, principal, lifecycle.assert);
    const admission = await admitInstallationRebinding(config, options, store, principal);
    const keep = async () => {
      const registration = await registry.registration();
      const result = attached ? await store.resolveRelocation({ choice, admission }, principal)
        : await store.resolvePlainRelocation({ choice, admission }, principal, lifecycle.assert);
      return { ...result, ...(registration?.source.installationId === result.installationId && registration.source.projectRoot !== config.projectRoot
        ? { attachmentRecordsUnreconciled: true as const } : {}) };
    };
    return admission.basis === 'macos-plain' ? lifecycle.hold(async () => {
      if (!await plainMacosRebinding(config, options, (await store.inspectPlainRebinding()).installationId))
        throw new InstallationIdentityError('INSTALLATION_IDENTITY_REBIND_REQUIRED');
      return keep();
    }) : keep();
  }, choice);
}
/** The CLI entry's read for a parsed local `deckent run hold|resume` naming its scope and Run (owner 2026-11-27): the same read every installation-bound
 * command takes. Only a refusal a binding repair may resolve then takes the interactive terminal's own repair for that scope, on the location the
 * refused read saw (a moved location stops with the existing binding-changed refusal before any write); any other failure keeps the read's own
 * refusal. Returns the repaired binding the control must still find, or undefined when nothing was repaired. */
export async function preflightConfiguredRunControl(root: string, scopeId: string, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, { ...options, heal: false }), location = controlLocation(config);
  try { await loadConfiguredInstallationIdentity(root, options, { config, inspectSource: inspectConfiguredInstallationSource }); return undefined; }
  catch (error) {
    // PROJECT_ATTACHMENT_UNAVAILABLE is left out: it also stands for a transient source read failure, which no repair proves.
    if (localPrincipalChannel() || !['PROJECT_ATTACHMENT_CHANGED', 'PROJECT_ATTACHMENT_DENIED', 'INSTALLATION_IDENTITY_RELOCATED'].some(code => isCodedError(error, code))) throw error;
    try {
      return (await admitTerminalContext(root, scopeId, options, undefined, seen => {
        if (seen !== location) throw ErrorRegistry.createError('RUN_CONTROL_BINDING_CHANGED');
      })).runControlBinding();
    } catch (repair) { throw isCodedError(repair, 'RUN_CONTROL_BINDING_CHANGED') ? repair : error; }
  }
}
/** Only an interactive terminal writer defers a potentially repairable registered attachment observation. */
export async function preflightConfiguredTerminalIdentity(root: string, options: ConfigLoadOptions, scopeId?: string) {
  try {
    const observed = await loadConfiguredInstallationIdentity(root, options);
    if (observed.status === 'unavailable' && observed.reason === 'unsupported') throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
  } catch (error) {
    const targetRepair = isCodedError(error, 'PROJECT_ATTACHMENT_CHANGED') || isCodedError(error, 'PROJECT_ATTACHMENT_DENIED');
    if (!targetRepair && !isCodedError(error, 'INSTALLATION_IDENTITY_RELOCATED') && !isCodedError(error, 'PROJECT_ATTACHMENT_UNAVAILABLE')) throw error;
    const config = await loadComposedConfig(root, { ...options, heal: false });
    const store = new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
    const registered = await store.registration().catch(() => null);
    if (targetRepair) {
      if (!registered || registered.unregistered || config.installation.sharedRegistrationId !== registered.registrationId
        || config.company.id !== registered.source.companyId) throw error;
      const local = await store.attachment();
      const entry = registered.entries.find(item => item.attachment.projectId === local?.projectId);
      if (!local || entry?.state !== 'active' || local.registrationId !== registered.registrationId
        || (scopeId !== undefined && local.scopeId !== scopeId) || !sameProjectAttachmentAuthority(entry.attachment, local)) throw error;
      return;
    }
    if (!registered || registered.unregistered || (config.installation.sharedRegistrationId !== registered.registrationId
      && (registered.source.projectRoot !== config.projectRoot || (scopeId !== undefined && registered.source.scopeId !== scopeId)))) throw error;
  }
}
/** Interactive session startup shares the existing managed-write principal, scope and policy admission. */
export async function ensureConfiguredTerminalIdentity(root: string, scopeId: string, options: ConfigLoadOptions, onSourceRepair?: (kind: SourceRepairKind) => void) {
  const { installationId, projectId } = await admitTerminalContext(root, scopeId, options, onSourceRepair);
  return Object.freeze({ installationId, projectId });
}
async function admitTerminalContext(root: string, scopeId: string, options: ConfigLoadOptions, onSourceRepair?: (kind: SourceRepairKind) => void, checkLocation?: CheckRunControlLocation) {
  await preflightConfiguredTerminalIdentity(root, options, scopeId);
  const { installationId, projectId, runControlBinding } = await timedScopeContext(root, scopeId, options, readLocalOsIdentity, 'write', undefined, onSourceRepair, checkLocation);
  if (!installationId) throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
  if (!projectId) throw ErrorRegistry.createError('PROJECT_IDENTITY_UNAVAILABLE');
  return { installationId, projectId, runControlBinding };
}

const timedScopeContext = timedAsync('scope-context', loadScopeContext);
