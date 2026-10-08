import { lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { policySchema, policyFileSchema, bindingsFileSchema, verifiedPrincipalSchema } from '#domain/index.js';
import { BackupApplication, policyBackupAuthorization, resolveBackupPolicyDocuments, backupCommandSchema, type BackupCommand, type BackupAuthority } from '#engine/index.js';
import { FileBackupStorage, readBackupConfig, verifyBackupSet, recordBackupAudit, type VerifiedBackup } from '#adapters/index.js';
import { readLocalOsIdentity, openLocalIntegrityAuthority, FileInstallationIdentityStore } from '#adapters/index.js';
import { ErrorRegistry, resolveGlobalConfigReadPath, productResourcePath, validateConfig, resolveProductLayout, restoreHoldPath, type ResolvedConfig, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { userInfo } from 'node:os';

/** Direct local SDK/CLI contract. Network surfaces must supply their authenticated peer through an admitted transport, never a principal body. */
export async function executeConfiguredBackup(projectRoot: string, input: BackupCommand, passphrase: string, options: ConfigLoadOptions = {}) {
  const parsed = backupCommandSchema.safeParse(input);
  if (!parsed.success) throw ErrorRegistry.createError('BACKUP_INPUT_INVALID');
  const command = parsed.data;
  let recovered: VerifiedBackup | undefined;
  try {
    let config: ResolvedConfig;
    try {
      if (command.action === 'restore' && !await lstat(join(resolve(projectRoot), '.deckent/config.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw ErrorRegistry.createError('BACKUP_STATE_MISSING');
      // Astra 2471 R1: only restore may complete an installation held by an unfinished restore; create/verify refuse the hold.
      config = await loadComposedConfig(projectRoot, { ...options, heal: false, secretResolver: async () => undefined, onWarning() {}, ...(command.action === 'restore' ? { restoreHold: 'admit' as const } : {}) }); }
    catch (error) {
      if (command.action !== 'restore') throw error;
      const limits = validateConfig({}).config.installation.packageMeasurement;
      recovered ??= await verifyBackupSet(command.set, passphrase, limits);
      const entry = recovered.state.entries.find(item => item.resource === 'config' && item.path === '');
      const document = validateConfig(JSON.parse(Buffer.from(entry!.content, 'base64').toString('utf8'))).config;
      const current = resolve(projectRoot) === recovered.state.projectRoot;
      const resources = Object.fromEntries(Object.entries(recovered.state.resources).filter(([key]) => !['config', 'projectIdentity', 'installationJournal'].includes(key)));
      const productLayout = resolveProductLayout({ projectRoot: resolve(projectRoot), ...(current ? { root: recovered.state.layoutRoot } : {}), resources });
      config = { ...document, projectRoot: resolve(projectRoot), productLayout, secretPaths: [] };
    }
    const layout = config.productLayout, limits = config.installation.packageMeasurement;
    const existingPolicy = await lstat(productResourcePath(layout, 'policy')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const identity = readLocalOsIdentity();
    let document, authority: BackupAuthority;
    // Astra 2471 R1: a held installation's policy pair is what the interrupted restore left; only then may restore fall back to the set's policy.
    const current = existingPolicy && await createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes).load().catch(async error => {
      if (command.action === 'restore' && await lstat(restoreHoldPath(projectRoot)).then(() => true, () => false)) return null; throw error; });
    if (current) {
      document = policySchema.parse(current);
      // Restore owns recovery and can read a moved identity from the authenticated set; every other command keeps the normal preflight.
      let installation;
      try { installation = await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read(); }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        if (command.action !== 'restore' || !['INSTALLATION_IDENTITY_INVALID', 'INSTALLATION_IDENTITY_RELOCATED', 'INSTALLATION_IDENTITY_UNAVAILABLE'].includes(String(code))) throw error;
      }
      if (installation?.status !== 'available') {
        if (command.action !== 'restore') throw ErrorRegistry.createError('BACKUP_STATE_MISSING');
        recovered ??= await verifyBackupSet(command.set, passphrase, limits);
      }
      authority = { principal: verifiedPrincipalSchema.parse({ ...identity, scopeIds: [command.scopeId] }),
        installationId: installation?.status === 'available' ? installation.value.installationId : recovered!.state.installationId,
        integrity: await (async () => {
          const path = join(productResourcePath(layout, 'approvals'), config.approvals.keyFile);
          const present = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (present || command.action !== 'restore') return openLocalIntegrityAuthority(layout, config.approvals.keyFile);
          recovered ??= await verifyBackupSet(command.set, passphrase, limits); return recovered.integrity();
        })() };
    } else {
      // Total loss: only a fully authenticated recovery set may supply the retained policy and identity. A malformed existing policy never falls back.
      if (command.action === 'create') throw ErrorRegistry.createError('BACKUP_STATE_MISSING');
      recovered ??= await verifyBackupSet(command.set, passphrase, limits);
      const item = recovered.state.entries.find(entry => entry.resource === 'policy' && entry.path === '');
      const policy = policyFileSchema.parse(JSON.parse(Buffer.from(item!.content, 'base64').toString('utf8')));
      const bindingEntry = recovered.state.entries.find(entry => entry.resource === 'bindings' && entry.path === '');
      const bindings = bindingsFileSchema.parse(JSON.parse(Buffer.from(bindingEntry!.content, 'base64').toString('utf8')));
      document = resolveBackupPolicyDocuments(policy, bindings);
      authority = { principal: verifiedPrincipalSchema.parse({ ...identity, scopeIds: [command.scopeId] }),
        installationId: recovered.state.installationId, integrity: recovered.integrity() };
    }
    const auditDirectory = command.action === 'restore' || !existingPolicy ? join(dirname(resolve(command.set)), '.deckent-backup-audit')
      : join(productResourcePath(layout, 'audit'), 'backup-operations');
    const configDocument = command.action === 'create' ? async () => readBackupConfig(layout.bootstrapConfigPath, await resolveGlobalConfigReadPath(options.env, options.platform), limits) : undefined;
    const source = { layout, projectRoot: resolve(projectRoot), installationId: authority.installationId, keyFile: config.approvals.keyFile, ...(configDocument ? { configDocument } : {}) };
    const app = new BackupApplication(new FileBackupStorage(source, limits), policyBackupAuthorization(document), (event, integrity) => recordBackupAudit(auditDirectory, event, integrity), authority);
    return await app.execute(command, passphrase);
  } finally { recovered?.close(); }
}
