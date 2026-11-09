import { relocateConfiguredProjectAttachment } from '#composition/core/attachment-lifecycle/index.js';
import { lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { policyFileSchema, bindingsFileSchema, verifiedPrincipalSchema } from '#domain/index.js';
import { BackupApplication, EffectTargetError, policyBackupAuthorization, resolveBackupPolicyDocuments, backupCommandSchema, type BackupCommand, type BackupAuthority, type BackupStoragePort } from '#engine/index.js';
import { PolicyFileError, FileBackupStorage, attachmentGuardedBackupStorage, attachmentLifecycle, archivedConfigDocument, readBackupConfig, verifyBackupSet, recordBackupAudit, type VerifiedBackup, verifySharedProjectRestore, BACKUP_AUDIT_LOCATIONS } from '#adapters/index.js';
import { readLocalOsIdentity, openLocalIntegrityAuthority, FileInstallationIdentityStore, uninstallRestoreRelease, uninstallRecoveryDirectory, restoreUninstallArchive, uninstallArchiveRoots } from '#adapters/index.js';
import { PRODUCT_LAYOUT_REGISTRY, ErrorRegistry, resolveGlobalConfigReadPath, productResourcePath, validateConfig, resolveProductLayout, restoreHoldPath, type ResolvedConfig, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';

/** Direct local SDK/CLI contract. Network surfaces must supply their authenticated peer through an admitted transport, never a principal body. */
export async function executeConfiguredBackup(projectRoot: string, input: BackupCommand, passphrase: string, options: ConfigLoadOptions = {}) {
  const parsed = backupCommandSchema.safeParse(input);
  if (!parsed.success) throw ErrorRegistry.createError('BACKUP_INPUT_INVALID');
  const command = parsed.data;
  let recovered: VerifiedBackup | undefined;
  // KG11 F4: one verified set per command; the first site that needs it decides the limits (the defaults only while the config is unreadable).
  const recover = async (limits: Parameters<typeof verifyBackupSet>[2]) => recovered ??= await verifyBackupSet(command.set, passphrase, limits);
  try {
    let config: ResolvedConfig;
    try {
      if (command.action === 'restore' && !await lstat(join(resolve(projectRoot), '.deckent/config.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw ErrorRegistry.createError('BACKUP_STATE_MISSING');
      // Astra 2471 R1: only restore may complete an installation held by an unfinished restore; create/verify refuse the hold.
      config = await loadComposedConfig(projectRoot, { ...options, heal: false, secretResolver: async () => undefined, onWarning() {}, ...(command.action === 'restore' ? { restoreHold: 'admit' as const } : {}) }); }
    catch (error) {
      if (command.action !== 'restore') throw error;
      const { state } = await recover(validateConfig({}).config.installation.packageMeasurement);
      const document = validateConfig(archivedConfigDocument(state)).config;
      const current = resolve(projectRoot) === state.projectRoot;
      const resources = Object.fromEntries(Object.entries(state.resources).filter(([key]) => !PRODUCT_LAYOUT_REGISTRY.fixedResources.includes(key)));
      const productLayout = resolveProductLayout({ projectRoot: resolve(projectRoot), ...(current ? { root: state.layoutRoot } : {}), resources });
      config = { ...document, projectRoot: resolve(projectRoot), productLayout, secretPaths: [] };
    }
    if (command.action === 'restore' && config.installation.sharedRegistrationId) await recover(config.installation.packageMeasurement);
    const sharedRestore = command.action === 'restore' && recovered ? await verifySharedProjectRestore(config, recovered, command.target, command.scopeId, options) : false;
    if (!sharedRestore) await attachmentLifecycle(config, options).assert(command.action === 'restore' ? [command.target] : [], 'backup');
    const layout = config.productLayout, limits = config.installation.packageMeasurement;
    const existingPolicy = await lstat(productResourcePath(layout, 'policy')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const identity = readLocalOsIdentity();
    const release = command.action === 'restore' ? await uninstallRestoreRelease(uninstallRecoveryDirectory(config, options.env ?? process.env), layout.root, { ...identity, scopeIds: [] }, config.installation.profileMaxBytes, command.set) : null;
    let document, authority: BackupAuthority;
    // Astra 2471 R1: a held installation's policy pair is what the interrupted restore left; only then may restore fall back to the set's policy.
    const current = existingPolicy && await contextPolicySource({ layout, config }).load().catch(async error => {
      if (command.action === 'restore' && await lstat(restoreHoldPath(projectRoot)).then(() => true, () => false)) return null;
      // S1 D3: a damaged policy file is a typed refusal naming the file and the next step; it never falls back to the set's policy here.
      if (!(error instanceof PolicyFileError)) throw error;
      const path = error.resource === 'archive' ? join(productResourcePath(layout, 'audit'), 'authority-revisions') : productResourcePath(layout, error.resource);
      throw ErrorRegistry.createError('BACKUP_POLICY_UNREADABLE', { params: { path, reason: error.code } }); });
    if (current) {
      document = current;
      // Restore owns recovery and can read a moved identity from the authenticated set; every other command keeps the normal preflight.
      let installation;
      try { installation = config.installation.sharedRegistrationId ? undefined : await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read(); }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        if (command.action !== 'restore' || !['INSTALLATION_IDENTITY_INVALID', 'INSTALLATION_IDENTITY_RELOCATED', 'INSTALLATION_IDENTITY_UNAVAILABLE'].includes(String(code))) throw error;
      }
      if (installation?.status !== 'available' && !config.installation.sharedRegistrationId) {
        if (command.action !== 'restore') throw ErrorRegistry.createError('BACKUP_STATE_MISSING');
        await recover(limits);
      }
      authority = { principal: verifiedPrincipalSchema.parse({ ...identity, scopeIds: [command.scopeId] }),
        installationId: config.installation.sharedRegistrationId ? sharedRestore ? recovered!.state.installationId : await attachmentLifecycle(config, options).identityId() : installation?.status === 'available' ? installation.value.installationId : recovered!.state.installationId,
        integrity: await (async () => {
          const path = join(productResourcePath(layout, 'approvals'), config.approvals.keyFile);
          const present = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (present || command.action !== 'restore') return openLocalIntegrityAuthority(layout, config.approvals.keyFile);
          return (await recover(limits)).integrity();
        })() };
    } else {
      // Total loss: only a fully authenticated recovery set may supply the retained policy and identity. A malformed existing policy never falls back.
      if (command.action === 'create') throw ErrorRegistry.createError('BACKUP_STATE_MISSING');
      const backup = await recover(limits);
      const item = backup.state.entries.find(entry => entry.resource === 'policy' && entry.path === '');
      const policy = policyFileSchema.parse(JSON.parse(Buffer.from(item!.content, 'base64').toString('utf8')));
      const bindingEntry = backup.state.entries.find(entry => entry.resource === 'bindings' && entry.path === '');
      const bindings = bindingsFileSchema.parse(JSON.parse(Buffer.from(bindingEntry!.content, 'base64').toString('utf8')));
      document = resolveBackupPolicyDocuments(policy, bindings);
      authority = { principal: verifiedPrincipalSchema.parse({ ...identity, scopeIds: [command.scopeId] }),
        installationId: backup.state.installationId, integrity: backup.integrity() };
    }
    const auditNextToSet = command.action === 'restore' || !existingPolicy;
    const auditDirectory = auditNextToSet ? join(dirname(resolve(command.set)), BACKUP_AUDIT_LOCATIONS.recovery) : join(productResourcePath(layout, 'audit'), BACKUP_AUDIT_LOCATIONS.installation);
    const globalConfigPath = await resolveGlobalConfigReadPath(options.env, options.platform);
    const configDocument = command.action === 'create' ? async () => readBackupConfig(layout.bootstrapConfigPath, globalConfigPath, limits) : undefined;
    const source = { layout, projectRoot: resolve(projectRoot), installationId: authority.installationId, keyFile: config.approvals.keyFile, globalConfigPath, ...(configDocument ? { configDocument } : {}) };
    const rawStorage = new FileBackupStorage(source, limits), storage = sharedRestore ? rawStorage : attachmentGuardedBackupStorage(rawStorage, config, options);
    // C-PRIO J1: a recovery audit lives next to the set, so a set that does not exist is refused before that audit is written (no stray
    // audit folder, never AUDIT_UNAVAILABLE for a mistyped path). Any other refusal of an existing set (unsafe, modified) is audited as before.
    if (auditNextToSet) await storage.locate(command.set).catch((error: unknown) => { if ((error as { code?: unknown } | null)?.code === 'BACKUP_SET_NOT_FOUND') throw error; });
    const app = new BackupApplication(storage, policyBackupAuthorization(document), (event, integrity) => recordBackupAudit(auditDirectory, event, integrity), authority, Date.now, async () => {
      await FileInstallationIdentityStore.assertTransferAllowed(layout);
      // A completed purge may leave an identity directory containing foreign files. Restore owns that retained loss;
      // a missing record is not a new identity. Genesis/raw markers are refused before this observation and by storage.
      const record = await lstat(join(productResourcePath(layout, 'installationIdentity'), 'identity.json'))
        .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!record) return undefined;
      const identity = await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
      return identity.status === 'available' ? identity.value : undefined;
    });
    // Lead 2026-10-27: a set an uninstall archived files beside also brings those files back (never over a file that exists again).
    const result = await app.execute(command, passphrase);
    if (command.action === 'restore') await restoreUninstallArchive(command.set, uninstallArchiveRoots(resolve(projectRoot), dirname(globalConfigPath), options.env), passphrase, limits);
    if (sharedRestore && command.action === 'restore') await relocateConfiguredProjectAttachment(command.target, command.scopeId, options, true);
    await release?.(); return result;
  } finally { recovered?.close(); }
}

/** KG11 F3: an uninstall set through the governed backup application (policy, audit beside the sets): created, then verified once with audit,
 * and that verify's handle is what `work` gets (R2: the set is not verified again). The handle is closed after `work`. */
export async function withVerifiedUninstallSet<T>(config: ResolvedConfig, request: { readonly set: string; readonly scopeId: string; readonly policy: unknown;
  readonly authority: BackupAuthority; readonly passphrase: string; readonly globalPath: string }, work: (verified: VerifiedBackup) => Promise<T>): Promise<T> {
  const { set, scopeId, authority, passphrase } = request, limits = config.installation.packageMeasurement, layout = config.productLayout;
  const unbound = (): never => { throw new EffectTargetError('EFFECT_TARGET_PRECONDITION'); };
  const storage = new FileBackupStorage({ layout, projectRoot: config.projectRoot, installationId: authority.installationId, keyFile: config.approvals.keyFile,
    configDocument: () => readBackupConfig(layout.bootstrapConfigPath, request.globalPath, limits) }, limits);
  let held: VerifiedBackup | undefined;
  const retaining: BackupStoragePort = { locate: path => storage.locate(path),
    execute: async (command, phrase) => command.action === 'verify' ? (held = await storage.open(command.set, phrase)).result('verify') : storage.execute(command, phrase) };
  const app = new BackupApplication(retaining, policyBackupAuthorization(request.policy),
    (event, integrity) => recordBackupAudit(join(dirname(set), BACKUP_AUDIT_LOCATIONS.uninstall), event, integrity), authority);
  try {
    await app.execute({ schemaVersion: 1, action: 'create', scopeId, set }, passphrase);
    await app.execute({ schemaVersion: 1, action: 'verify', scopeId, set }, passphrase);
    const verified = held ?? unbound();
    verified.assertInstallation(authority.installationId, unbound);
    return await work(verified);
  } finally { held?.close(); }
}
