import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { acquireLedgerLock } from '#adapters/core/local-runtime-socket/index.js';
import { ConfigValidationError, configSections, deepMerge, getConfigFieldDefault, isRecord, readJsonFile, sha256, validateConfig, versionedConfig, productResourcePath, resolveProductLayout, restoreHoldPath, writeConfig, type ProductLayout } from '#platform/index.js';
import type { BackupCommand, BackupResult, BackupStoragePort } from '#engine/index.js';
import { ledgerFingerprint, openSetLedger } from './fingerprint.js';
import { createBackupSet, verifyBackupSet, type VerifiedBackup } from './set.js';
import { BACKUP_RESOURCES, directoryResources, splitArchivedConfig, type BackupConfigLayers, type BackupLimits } from './archive.js';
import { inside, ownerOnlyWritable, privateDirectory, readPrivate, refuse, safePath, syncDirectory, writePrivate } from './files.js';
const FIXED = ['config', 'projectIdentity', 'installationJournal'];
const STAGE_PREFIX = '.backup-restore-', KEY_TEMP_INFIX = '.restore-', UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * S1 D4: what an interrupted restore can leave behind: its stage (plaintext ledger and state; alpha.18 staged it in the project root and
 * staged the decrypted authority key too), a pending hold file and a decrypted key that was not yet renamed into place. Read-only; only
 * entries of this user with the exact generated names are listed. Doctor shows them; the next successful restore removes them.
 */
export async function restoreLeftovers(projectRoot: string, approvals: string, keyFile: string): Promise<string[]> {
  const area = dirname(restoreHoldPath(projectRoot)), found: string[] = [];
  const stagePattern = new RegExp(`^${escape(STAGE_PREFIX)}${UUID}$`);
  const scan = async (directory: string, pattern: RegExp, kind: 'directory' | 'file') => {
    const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [] as string[]; throw error; });
    for (const name of names.filter(item => pattern.test(item)).sort()) {
      const info = await lstat(join(directory, name)).catch(() => null);
      if (info && info.uid === process.getuid?.() && (kind === 'directory' ? info.isDirectory() : info.isFile())) found.push(join(directory, name));
    }
  };
  await scan(area, stagePattern, 'directory'); await scan(resolve(projectRoot), stagePattern, 'directory');
  await scan(area, new RegExp(`^${escape(basename(restoreHoldPath(projectRoot)))}\\.${UUID}$`), 'file');
  await scan(approvals, new RegExp(`^\\.${escape(keyFile)}${escape(KEY_TEMP_INFIX)}${UUID}$`), 'file');
  return found;
}

export interface BackupSource { readonly layout: ProductLayout; readonly projectRoot: string; readonly installationId: string; readonly keyFile: string;
  readonly configDocument?: () => Promise<BackupConfigLayers>;
  /** The per-user global config file of the restoring environment (S1 D1); absent: the global layer is not restored. */
  readonly globalConfigPath?: string }
export class FileBackupStorage implements BackupStoragePort {
  constructor(private readonly source: BackupSource, private readonly limits: BackupLimits) {}
  async execute(command: BackupCommand, passphrase: string): Promise<BackupResult> {
    if (command.action === 'create') return createBackupSet(this.source.layout, this.source.projectRoot, this.source.installationId,
      this.source.keyFile, command.set, passphrase, this.limits, await this.source.configDocument?.());
    const verified = await verifyBackupSet(command.set, passphrase, this.limits);
    try { return command.action === 'verify' ? verified.result('verify') : await this.restore(command, verified); }
    finally { verified.close(); }
  }
  private async restore(command: Extract<BackupCommand, { action: 'restore' }>, verified: VerifiedBackup): Promise<BackupResult> {
    const target = await safePath(command.target), state = verified.state;
    if (state.installationId !== this.source.installationId) return refuse('BACKUP_TARGET_IDENTITY_MISMATCH');
    if (inside(target, verified.set) || inside(verified.set, target)) return refuse('BACKUP_PATH_UNSAFE');
    const exists = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (exists && (!exists.isDirectory() || exists.uid !== process.getuid?.())) return refuse('BACKUP_PATH_UNSAFE');
    if (exists && (await readdir(target)).length && command.confirmTarget !== target) return refuse('BACKUP_TARGET_NOT_EMPTY');
    const same = target === resolve(this.source.projectRoot);
    const customResources = Object.fromEntries(Object.entries(state.resources).filter(([key]) => !FIXED.includes(key)));
    const layout = same ? this.source.layout : resolveProductLayout({ projectRoot: target, resources: customResources });
    // Astra 2471 R2: the restored config names exactly the layout every resource is published into (same root keeps the current map).
    const targetResources = Object.fromEntries(Object.entries(layout.resources).filter(([key]) => !FIXED.includes(key)));
    const archivedLayout = resolveProductLayout({ projectRoot: state.projectRoot, root: state.layoutRoot, resources: customResources });
    if (target === state.projectRoot && productResourcePath(layout, 'ledger') !== productResourcePath(archivedLayout, 'ledger')) return refuse('BACKUP_PATH_UNSAFE');
    const targetConfig = join(target, '.deckent/config.json');
    if (!same && await lstat(targetConfig).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
      // An existing target may host its service in another layout. Never replace its bootstrap while checking an unrelated ledger lock.
      let current;
      try { current = validateConfig(JSON.parse((await readPrivate(targetConfig, this.limits.maxFileBytes)).toString('utf8'))).config; }
      catch { return refuse('BACKUP_PATH_UNSAFE'); }
      const currentLayout = resolveProductLayout({ projectRoot: target, ...(current.layout.root ? { root: current.layout.root } : {}), resources: current.layout.resources });
      for (const resource of [...BACKUP_RESOURCES, 'ledger' as const, 'approvals' as const, 'runtimeSocket' as const])
        if (productResourcePath(currentLayout, resource) !== productResourcePath(layout, resource)) return refuse('BACKUP_PATH_UNSAFE');
    }
    const identityPath = join(productResourcePath(layout, 'installationIdentity'), 'identity.json');
    if (!same && await lstat(identityPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
      let identity: unknown;
      try { identity = JSON.parse((await readPrivate(identityPath, this.limits.maxFileBytes)).toString('utf8')); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (identity && typeof identity === 'object' && 'installationId' in identity && identity.installationId !== state.installationId) return refuse('BACKUP_TARGET_IDENTITY_MISMATCH');
    }
    const hold = restoreHoldPath(target), paths = [...BACKUP_RESOURCES, 'ledger' as const, 'approvals' as const].map(resource => productResourcePath(layout, resource));
    // S1 D4: the stage lives in the installation's private area beside the hold (never the project root) and holds no plaintext key.
    const stage = join(dirname(hold), `${STAGE_PREFIX}${randomUUID()}`);
    if (paths.some(path => inside(path, hold) || inside(hold, path) || inside(path, stage) || inside(stage, path))) return refuse('BACKUP_PATH_UNSAFE');
    // A nested/aliased resource cannot be published atomically as independent state. Refuse before any target write.
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++)
      if (inside(paths[i]!, paths[j]!) || inside(paths[j]!, paths[i]!)) return refuse('BACKUP_PATH_UNSAFE');
    for (const path of [...paths, productResourcePath(layout, 'ledger'), productResourcePath(layout, 'approvals')]) await safePath(path);
    // S1 D2: every existing directory this restore writes into is checked before staging, custody or any write.
    for (const directory of new Set([dirname(hold), ...paths.map(path => dirname(path)), productResourcePath(layout, 'approvals'), ...(exists ? [] : [dirname(target)])]))
      await ownerOnlyWritable(directory);
    const socket = productResourcePath(layout, 'runtimeSocket');
    if (await lstat(socket).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return refuse('BACKUP_SERVICE_RUNNING');
    if (!exists) { await privateDirectory(dirname(target)); await mkdir(target, { mode: 0o700 }); }
    await privateDirectory(dirname(productResourcePath(layout, 'ledger')));
    let lock;
    try { lock = acquireLedgerLock(productResourcePath(layout, 'ledger') + '-lock'); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'LOCAL_RUNTIME_ALREADY_RUNNING') return refuse('BACKUP_SERVICE_RUNNING'); return refuse('BACKUP_CUSTODY_UNAVAILABLE'); }
    let published = false, holdCreated = false;
    let restoredConfig: ReturnType<typeof validateConfig>['config'] | undefined, globalPlan: Awaited<ReturnType<typeof planGlobalLayer>> | null = null, globalConfig: BackupResult['globalConfig'] = null;
    const token = randomUUID(), preserved: string[] = [], changed = new Set<string>();
    try {
      // Recheck under the same kernel custody the service must acquire before any migration or startup.
      if (await lstat(socket).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return refuse('BACKUP_SERVICE_RUNNING');
      await privateDirectory(stage); await writePrivate(join(stage, '.gitignore'), '*\n');
      const staged = resolveProductLayout({ projectRoot: stage, resources: customResources });
      for (const item of state.entries) {
        const isDir = directoryResources.has(item.resource);
        if ((!isDir && item.path !== '') || (isDir && item.path === '')) return refuse('BACKUP_SET_INVALID');
        let content = Buffer.from(item.content, 'base64');
        if (item.resource === 'config') {
          const relocate = (value: unknown, pointer: string): unknown => {
            if (typeof value === 'string') {
              const mapping = [[state.layoutRoot, layout.root], [state.projectRoot, target]] as const;
              for (const [before, after] of mapping) if (inside(before, value) && before !== after) { changed.add(pointer); return after + value.slice(before.length); }
              return value;
            }
            if (Array.isArray(value)) return value.map((item, i) => relocate(item, `${pointer}/${i}`));
            if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item, `${pointer}/${key}`)]));
            return value;
          };
          // S1 D1: the project layer is published as the project config; the global layer only fills the per-user global config below.
          const layers = splitArchivedConfig(state), config = relocate(layers.project, '') as Record<string, unknown>;
          config['layout'] = { ...(config['layout'] as Record<string, unknown> | undefined), root: layout.root, resources: targetResources };
          // A restored scheduler must be re-enabled deliberately after identity keep and credential provisioning.
          config['backup'] = { ...(config['backup'] as Record<string, unknown> | undefined), schedule: getConfigFieldDefault('backup').schedule };
          // Astra 2475 R1: before any write, check the TARGET's effective config (its loaded global layer under this project layer, normalized like loading); bind the published key to the name it opens (project layer; the global stays).
          globalPlan = this.source.globalConfigPath ? await planGlobalLayer(this.source.globalConfigPath, layers.global) : null;
          const targetGlobal = globalPlan?.effective ?? {}, conflict = (section: string) => refuse('BACKUP_TARGET_CONFIG_CONFLICT', { path: globalPlan?.path ?? '', section });
          for (const [name, section] of configSections()) {
            try { section.options.validateLayers?.(layers.global[name], config[name]); } catch { return refuse('BACKUP_SET_INVALID'); }
            try { section.options.validateLayers?.(targetGlobal[name], config[name]); } catch { return conflict(name); }
          }
          const effective = () => { try { return validateConfig(deepMerge(versionedConfig(targetGlobal), versionedConfig(config))).config; }
            catch (error) { return conflict(error instanceof ConfigValidationError ? String(error.issues[0]?.path ?? '').split('.')[0] || 'config' : 'config'); } };
          if (effective().approvals.keyFile !== state.keyFile) { config['approvals'] = { ...(config['approvals'] as Record<string, unknown> | undefined), keyFile: state.keyFile }; changed.add('/approvals/keyFile'); }
          restoredConfig = effective();
          changed.add('/backup/schedule'); content = Buffer.from(JSON.stringify(config, null, 2) + '\n');
        }
        await writePrivate(join(productResourcePath(staged, item.resource), ...(item.path ? item.path.split('/') : [])), content);
      }
      // Snapshot ledger uses online backup again; never copy a live WAL-ledger or share verification sidecars.
      const { backup } = await import('node:sqlite');
      const ledger = productResourcePath(staged, 'ledger'); await writePrivate(ledger, new Uint8Array());
      const db = openSetLedger(join(verified.set, 'ledger.db'));
      try { await backup(db, ledger); } finally { db.close(); }
      if (ledgerFingerprint(ledger) !== ledgerFingerprint(join(verified.set, 'ledger.db'))) return refuse('BACKUP_FINGERPRINT_INVALID');
      // Astra 2471 R1: a durable hold precedes the first publication; config admission refuses it until the last one completed.
      if (!await lstat(hold).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
        const pending = `${hold}.${token}`; await writePrivate(pending, JSON.stringify({ schemaVersion: 1, kind: 'backup-restore', operation: token, target, startedAt: new Date().toISOString() }) + '\n');
        holdCreated = true; await rename(pending, hold); await syncDirectory(dirname(hold));
      }
      const publish = async (from: string, to: string) => {
        await privateDirectory(dirname(to));
        if (await lstat(to).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
          const saved = `${to}.damaged-${token}`; await rename(to, saved); published = true; preserved.push(saved);
        }
        await rename(from, to); published = true; await syncDirectory(dirname(to));
      };
      if (globalPlan) globalConfig = await globalPlan.apply(token, preserved, () => { published = true; });
      // Preserve the whole old directory, including stale files absent from the recovery set. Keep ledger-lock's inode throughout.
      for (const resource of BACKUP_RESOURCES) {
        const from = productResourcePath(staged, resource);
        if (!await lstat(from).catch(() => null)) {
          if (directoryResources.has(resource)) await privateDirectory(from); else return refuse('BACKUP_SET_INVALID');
        }
        await publish(from, productResourcePath(layout, resource));
      }
      // The authority key is decrypted only now, next to its final name in the approvals directory, and renamed into place.
      const approvals = productResourcePath(layout, 'approvals'), keyTemp = join(approvals, `.${state.keyFile}${KEY_TEMP_INFIX}${token}`);
      await verified.restoreKey(keyTemp); await publish(keyTemp, join(approvals, state.keyFile));
      for (const suffix of ['-wal', '-shm', '-journal']) {
        const path = productResourcePath(layout, 'ledger') + suffix;
        if (await lstat(path).catch(() => null)) { await safePath(path); const saved = `${path}.damaged-${token}`; await rename(path, saved); preserved.push(saved); }
      }
      await publish(ledger, productResourcePath(layout, 'ledger'));
      // Astra 2475 R1: the hold stays unless the key the effective config opens is the set's key (same derivation as the keyring's key id).
      if (sha256((await readPrivate(join(approvals, restoredConfig!.approvals.keyFile), 32)).toString('hex')) !== verified.integrity().keyId) return refuse('BACKUP_RESTORE_INCOMPLETE');
      let required = false;
      try { await new FileInstallationIdentityStore(layout, restoredConfig!.configFile.writeLockTimeoutMs, undefined, restoredConfig!.installation).read(); }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'INSTALLATION_IDENTITY_RELOCATED') required = true; else throw error; }
      await rm(stage, { recursive: true, force: true });
      // S1 D4: an earlier interrupted attempt's stage (also alpha.18's project-root location) and pending key/hold files go with this success.
      for (const leftover of await restoreLeftovers(target, productResourcePath(layout, 'approvals'), state.keyFile)) await rm(leftover, { recursive: true, force: true });
      await rm(hold); await syncDirectory(dirname(hold));
      return { ...verified.result('restore'), relocation: { required, target, changedPaths: [...changed].sort() }, globalConfig, preserved };
    } catch (error) {
      if (published) return refuse('BACKUP_RESTORE_INCOMPLETE');
      // Nothing was published: a hold this attempt created is withdrawn; an earlier attempt's hold stays.
      if (holdCreated) { await rm(hold, { force: true }); await rm(`${hold}.${token}`, { force: true }); await syncDirectory(dirname(hold)); }
      throw error;
    }
    finally { try { if (!published || await lstat(stage).then(() => false, () => true)) await rm(stage, { recursive: true, force: true }); } finally { lock.release(); } }
  }
}

/** S1 D1: the per-user global config is shared by this user's installations: restore adds only archived sections it lacks, never replaces a present
 * one (`kept`), keeps an unreadable file (ignored by config loading) as `.damaged-<token>` and writes with the config writer (lock, read digest
 * precondition, atomic 0600). Astra 2475 R1: read before any write; `effective` is the layer loaded after restore; no archived layer, no write. */
async function planGlobalLayer(path: string, archived: Record<string, unknown>) {
  const current = await readJsonFile(path); if (current.kind === 'io') throw current.error;
  const ready = current.kind === 'ready' && isRecord(current.value) ? current : null, present = ready ? ready.value as Record<string, unknown> : {};
  const added = Object.keys(archived).filter(name => !Object.hasOwn(present, name)).sort(), effective = { ...present, ...Object.fromEntries(added.map(name => [name, archived[name]])) };
  const kept = Object.keys(archived).filter(name => Object.hasOwn(present, name) && JSON.stringify(present[name]) !== JSON.stringify(archived[name])).sort();
  return { path, effective, apply: async (token: string, preserved: string[], effect: () => void): Promise<BackupResult['globalConfig']> => {
    if (!Object.keys(archived).length) return null;
    if (current.kind !== 'absent' && !ready) { const saved = `${path}.damaged-${token}`; effect(); await rename(path, saved); preserved.push(saved); }
    if (added.length) { effect(); await writeConfig(path, effective, ready ? ready.digest : null); }
    return { path, added, kept }; } };
}
