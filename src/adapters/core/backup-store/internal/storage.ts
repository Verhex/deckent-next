import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { acquireLedgerLock } from '#adapters/core/local-runtime-socket/index.js';
import { getConfigFieldDefault, validateConfig, productResourcePath, resolveProductLayout, type ProductLayout } from '#platform/index.js';
import type { BackupCommand, BackupResult, BackupStoragePort } from '#engine/index.js';
import { ledgerFingerprint } from './fingerprint.js';
import { createBackupSet, verifyBackupSet, type VerifiedBackup } from './set.js';
import { BACKUP_RESOURCES, directoryResources, type BackupLimits } from './archive.js';
import { inside, privateDirectory, readPrivate, refuse, safePath, syncDirectory, writePrivate } from './files.js';

export interface BackupSource { readonly layout: ProductLayout; readonly projectRoot: string; readonly installationId: string; readonly keyFile: string; readonly configDocument?: () => Promise<Buffer> }
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
    const customResources = Object.fromEntries(Object.entries(state.resources).filter(([key]) => !['config', 'projectIdentity', 'installationJournal'].includes(key)));
    const layout = same ? this.source.layout : resolveProductLayout({ projectRoot: target, resources: customResources });
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
    const paths = [...BACKUP_RESOURCES, 'ledger' as const, 'approvals' as const].map(resource => productResourcePath(layout, resource));
    // A nested/aliased resource cannot be published atomically as independent state. Refuse before any target write.
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++)
      if (inside(paths[i]!, paths[j]!) || inside(paths[j]!, paths[i]!)) return refuse('BACKUP_PATH_UNSAFE');
    for (const path of [...paths, productResourcePath(layout, 'ledger'), productResourcePath(layout, 'approvals')]) await safePath(path);
    const socket = productResourcePath(layout, 'runtimeSocket');
    if (await lstat(socket).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return refuse('BACKUP_SERVICE_RUNNING');
    if (!exists) { await privateDirectory(dirname(target)); await mkdir(target, { mode: 0o700 }); }
    await privateDirectory(dirname(productResourcePath(layout, 'ledger')));
    let lock;
    try { lock = acquireLedgerLock(productResourcePath(layout, 'ledger') + '-lock'); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'LOCAL_RUNTIME_ALREADY_RUNNING') return refuse('BACKUP_SERVICE_RUNNING'); return refuse('BACKUP_CUSTODY_UNAVAILABLE'); }
    let published = false;
    let restoredConfig: ReturnType<typeof validateConfig>['config'] | undefined;
    const stage = join(target, `.backup-restore-${randomUUID()}`), token = randomUUID(), preserved: string[] = [], changed = new Set<string>();
    try {
      // Recheck under the same kernel custody the service must acquire before any migration or startup.
      if (await lstat(socket).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return refuse('BACKUP_SERVICE_RUNNING');
      await privateDirectory(stage);
      const staged = resolveProductLayout({ projectRoot: stage, resources: customResources });
      for (const item of state.entries) {
        const isDir = directoryResources.has(item.resource);
        if ((!isDir && item.path !== '') || (isDir && item.path === '')) return refuse('BACKUP_SET_INVALID');
        let content = Buffer.from(item.content, 'base64');
        if (item.resource === 'config') {
          const raw: unknown = JSON.parse(content.toString('utf8'));
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
          const config = relocate(raw, '') as Record<string, unknown>;
          config['layout'] = { ...(config['layout'] as Record<string, unknown> | undefined), root: layout.root, resources: customResources };
          // A restored scheduler must be re-enabled deliberately after identity keep and credential provisioning.
          config['backup'] = { ...(config['backup'] as Record<string, unknown> | undefined), schedule: getConfigFieldDefault('backup').schedule };
          restoredConfig = validateConfig(config).config;
          changed.add('/backup/schedule'); content = Buffer.from(JSON.stringify(config, null, 2) + '\n');
        }
        await writePrivate(join(productResourcePath(staged, item.resource), ...(item.path ? item.path.split('/') : [])), content);
      }
      await verified.restoreKey(join(productResourcePath(staged, 'approvals'), state.keyFile));
      // Snapshot ledger uses online backup again; never copy a live WAL-ledger or share verification sidecars.
      const { backup, DatabaseSync } = await import('node:sqlite');
      const ledger = productResourcePath(staged, 'ledger'); await writePrivate(ledger, new Uint8Array());
      const db = new DatabaseSync(join(verified.set, 'ledger.db'), { readOnly: true });
      try { await backup(db, ledger); } finally { db.close(); }
      if (ledgerFingerprint(ledger) !== ledgerFingerprint(join(verified.set, 'ledger.db'))) return refuse('BACKUP_FINGERPRINT_INVALID');
      const publish = async (from: string, to: string) => {
        await privateDirectory(dirname(to));
        if (await lstat(to).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
          const saved = `${to}.damaged-${token}`; await rename(to, saved); published = true; preserved.push(saved);
        }
        await rename(from, to); published = true; await syncDirectory(dirname(to));
      };
      // Preserve the whole old directory, including stale files absent from the recovery set. Keep ledger-lock's inode throughout.
      for (const resource of BACKUP_RESOURCES) {
        const from = productResourcePath(staged, resource);
        if (!await lstat(from).catch(() => null)) {
          if (directoryResources.has(resource)) await privateDirectory(from); else return refuse('BACKUP_SET_INVALID');
        }
        await publish(from, productResourcePath(layout, resource));
      }
      await publish(join(productResourcePath(staged, 'approvals'), state.keyFile), join(productResourcePath(layout, 'approvals'), state.keyFile));
      for (const suffix of ['-wal', '-shm', '-journal']) {
        const path = productResourcePath(layout, 'ledger') + suffix;
        if (await lstat(path).catch(() => null)) { await safePath(path); const saved = `${path}.damaged-${token}`; await rename(path, saved); preserved.push(saved); }
      }
      await publish(ledger, productResourcePath(layout, 'ledger'));
      let required = false;
      try { await new FileInstallationIdentityStore(layout, restoredConfig!.configFile.writeLockTimeoutMs, undefined, restoredConfig!.installation).read(); }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'INSTALLATION_IDENTITY_RELOCATED') required = true; else throw error; }
      await rm(stage, { recursive: true, force: true });
      return { ...verified.result('restore'), relocation: { required, target, changedPaths: [...changed].sort() }, preserved };
    } catch (error) { if (published) return refuse('BACKUP_RESTORE_INCOMPLETE'); throw error; }
    finally { try { if (!published || await lstat(stage).then(() => false, () => true)) await rm(stage, { recursive: true, force: true }); } finally { lock.release(); } }
  }
}
