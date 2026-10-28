import { CURRENT_LEDGER_VERSION, openConfiguredSecretStore, inspectScheduledSets, pruneScheduledSets } from '#adapters/index.js';
import { setTimeout as wait } from 'node:timers/promises';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { ErrorRegistry, productResourcePath, prepareProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { executeConfiguredBackup } from './application.js';
import type { BackupScheduleObserver, BackupScheduleEvent } from '#engine/index.js';
export type { BackupScheduleObserver } from '#engine/index.js';
/** The fixed secret name is provisioned through `secret set` (masked/stdin); config selects only frequency and retention. */
export const BACKUP_SCHEDULE_SECRET = 'BACKUP_PASSPHRASE';
async function report(observer: BackupScheduleObserver, event: BackupScheduleEvent) {
  try { await observer.onBackup?.(event); } catch { /* A rendering failure cannot change or stop an already audited backup. */ }
}
/** The time a scheduled set's own name carries (`recovery-<UTC second, ':' as '-'>-<uuid>`); NaN for any other name. */
const namedAt = (name: string) => Date.parse(/^recovery-(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\dZ)-[0-9a-f-]{36}$/u.exec(name)?.slice(1).join(':') ?? '');
const failureCode = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.startsWith('BACKUP_') ? error.code : 'BACKUP_IO';
async function runScheduledBackup(root: string, options: ConfigLoadOptions, trigger: 'daily' | 'before-upgrade', observer: BackupScheduleObserver) {
  const config = await loadComposedConfig(root, { ...options, heal: false });
  if (config.backup.schedule !== trigger) return;
  const scopeId = config.service.identity?.scopeId;
  if (!scopeId) throw ErrorRegistry.createError('BACKUP_SCHEDULE_IDENTITY_REQUIRED');
  const passphrase = await openConfiguredSecretStore(config, options.env ?? process.env, options.platform).get(BACKUP_SCHEDULE_SECRET);
  if (!passphrase) throw ErrorRegistry.createError('BACKUP_SCHEDULE_SECRET_REQUIRED');
  const directory = join(await prepareProductDirectory(config.productLayout, 'ledgerBackups'), 'recovery');
  const { mkdir, readdir } = await import('node:fs/promises');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // g2-yedek-dakika: the minute loop decides from the names this schedule writes (below), with no decryption or ledger scan;
  // full verification runs only when a new set is due (a 'daily' schedule: one day after the newest).
  if (trigger === 'daily' && (await readdir(directory)).some(name => Date.now() - namedAt(name) < 86400000)) return;
  // Daily only (owner 2026-10-18): an older set that no longer verifies is reported and kept and never blocks the new set; before an upgrade it still stops the migration.
  const unverified: BackupScheduleEvent[] = [];
  const ordered = await inspectScheduledSets(directory, passphrase, config.installation.packageMeasurement,
    trigger === 'daily' ? (set, error) => { unverified.push({ trigger, status: 'skipped', code: failureCode(error), set }); } : undefined);
  for (const event of unverified) await report(observer, event);
  const name = `recovery-${new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}/, '')}-${randomUUID()}`;
  await executeConfiguredBackup(root, { schemaVersion: 1, action: 'create', scopeId, set: join(directory, name) }, passphrase, options);
  // Keep only authenticated scheduled sets after a new complete set exists; foreign names are untouched.
  await pruneScheduledSets(directory, ordered, config.backup.retention, passphrase, config.installation.packageMeasurement);
  await report(observer, { trigger, status: 'created', code: null });
}
/** node:sqlite loads only when a ledger is actually opened, so importing the SDK never loads the native module (sqlite-ledger-lazy). */
const nativeSqlite = () => createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
/** Called under service ledger custody before schema migration; failure prevents the upgrade. Fresh installs have nothing to back up. */
export async function prepareScheduledBackup(root: string, options: ConfigLoadOptions, observer: BackupScheduleObserver = {}) {
  const config = await loadComposedConfig(root, { ...options, heal: false });
  if (config.backup.schedule !== 'before-upgrade') return;
  const ledger = productResourcePath(config.productLayout, 'ledger');
  if (!await lstat(ledger).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return;
  const db = new (nativeSqlite().DatabaseSync)(ledger, { readOnly: true });
  let version;
  try { version = Number(db.prepare('PRAGMA user_version').get()?.['user_version']); } finally { db.close(); }
  if (version >= CURRENT_LEDGER_VERSION) return;
  await runScheduledBackup(root, options, 'before-upgrade', observer);
}
/** The service waits in-flight backup work on shutdown before releasing ledger custody; timers stop on its AbortSignal. */
export function startBackupSchedule(root: string, options: ConfigLoadOptions, signal: AbortSignal, observer: BackupScheduleObserver = {}) {
  return (async () => {
    const config = await loadComposedConfig(root, { ...options, heal: false });
    if (config.backup.schedule !== 'daily') return;
    while (!signal.aborted) {
      try { await runScheduledBackup(root, options, 'daily', observer); }
      catch (error) { await report(observer, { trigger: 'daily', status: 'failed', code: failureCode(error) }); }
      try { await wait(60000, undefined, { signal }); } catch { if (signal.aborted) return; }
    }
  })().catch(error => report(observer, { trigger: 'daily', status: 'failed', code: failureCode(error) }));
}
