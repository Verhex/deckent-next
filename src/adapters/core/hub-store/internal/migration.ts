import { constants, closeSync, fsyncSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { hubRevocationFeedSchema } from '#domain/index.js';
import { HubServerError } from '#engine/index.js';
import { createHubService } from './service.js';
import { createHubRevocations, recordHubRevocations } from './revocations.js';

export const HUB_STORE_SCHEMA_VERSION = 3;
/** Exclusive 0600 backup; existing backups are never overwritten. Call before BEGIN, then compare its receipt tail under the writer lock. */
export function backupHubV1(db: DatabaseSync, path: string, version = 1) {
  const backup = `${path}.v${version}.bak`, fd = openSync(backup, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { db.prepare('VACUUM INTO ?').run(backup); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const copy = new NativeDatabase(backup, { readOnly: true });
  try { return copy.prepare('SELECT digest FROM hub_receipts ORDER BY sequence DESC LIMIT 1').get()?.digest ?? null; }
  finally { copy.close(); }
}
/** No lossy down migration. Older binaries require the pre-switch v1 backup, not a lowered version pin. */
export function migrateHubV1(db: DatabaseSync, backupTail: unknown) {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 1
    || (db.prepare('SELECT digest FROM hub_receipts ORDER BY sequence DESC LIMIT 1').get()?.digest ?? null) !== backupTail) throw new HubServerError('HUB_STORE_UNSAFE');
  createHubRevocations(db);
  for (const row of db.prepare("SELECT record FROM hub_receipts WHERE json_extract(record,'$.action') IN ('yank','revoke') ORDER BY sequence").iterate())
    recordHubRevocations(db, hubRevocationFeedSchema.parse(JSON.parse(String(row.record)).feed));
  createHubService(db);
  db.exec(`PRAGMA user_version=${HUB_STORE_SCHEMA_VERSION}`);
}

/** v2 rollback uses the exclusive pre-switch backup; never relabel a v3 database. */
export function migrateHubV2(db: DatabaseSync, backupTail: unknown) {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 2
    || (db.prepare('SELECT digest FROM hub_receipts ORDER BY sequence DESC LIMIT 1').get()?.digest ?? null) !== backupTail) throw new HubServerError('HUB_STORE_UNSAFE');
  createHubService(db);
  db.exec(`PRAGMA user_version=${HUB_STORE_SCHEMA_VERSION}`);
}
