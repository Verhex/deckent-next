import { openLedgerDatabase } from '#adapters/core/sqlite-ledger/index.js';
import { constants, closeSync, fsyncSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { hubRevocationFeedSchema } from '#domain/index.js';
import { HubServerError } from '#engine/index.js';
import { createHubService } from './service.js';
import { createHubRevocations, recordHubRevocations } from './revocations.js';

export const HUB_STORE_SCHEMA_VERSION = 4;
/** Exclusive 0600 backup; existing backups are never overwritten. Call before BEGIN, then compare its receipt tail under the writer lock. */
export function backupHubStore(db: DatabaseSync, path: string, version = 1) {
  const backup = `${path}.v${version}.bak`, fd = openSync(backup, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { db.prepare('VACUUM INTO ?').run(backup); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  const copy = openLedgerDatabase(backup, { readOnly: true });
  try { return copy.prepare('SELECT digest FROM hub_receipts ORDER BY sequence DESC LIMIT 1').get()?.digest ?? null; }
  finally { copy.close(); }
}
export function createHubIndexes(db: DatabaseSync) {
  db.exec(`CREATE INDEX hub_package_latest ON hub_versions(package_id,ordinal);
    CREATE INDEX hub_package_page ON hub_versions(package_id||'@'||version);
    CREATE INDEX hub_latest_feed ON hub_receipts(sequence) WHERE json_type(record,'$.feed')='object';
    CREATE INDEX hub_public_audit ON hub_service_audit(sequence) WHERE public_entry=1;`);
}
/** Rollback uses the exclusive pre-switch backup; never relabel an upgraded database. */
export function migrateHubStore(db: DatabaseSync, version: number, backupTail: unknown) {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== version
    || (db.prepare('SELECT digest FROM hub_receipts ORDER BY sequence DESC LIMIT 1').get()?.digest ?? null) !== backupTail) throw new HubServerError('HUB_STORE_UNSAFE');
  if (version === 1) {
    createHubRevocations(db);
    for (const row of db.prepare("SELECT record FROM hub_receipts WHERE json_extract(record,'$.action') IN ('yank','revoke') ORDER BY sequence").iterate())
      recordHubRevocations(db, hubRevocationFeedSchema.parse(JSON.parse(String(row.record)).feed));
  }
  if (version < 3) createHubService(db);
  createHubIndexes(db);
  db.exec(`PRAGMA user_version=${HUB_STORE_SCHEMA_VERSION}`);
}
