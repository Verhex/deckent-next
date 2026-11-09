// Offline proof only: a COPY and the old reader prove the upgrade/backup boundary, not supported alpha.64 rollback.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 2) throw new Error('Usage: node scripts/prove-ledger-upgrade.mjs LEDGER_COPY ALPHA63_3_LEDGER_READER_MODULE');
const scratch = mkdtempSync(join(tmpdir(), 'deckent-ledger-proof-'));
process.env.DECKENT_GLOBAL_HOME = join(scratch, 'global'); mkdirSync(process.env.DECKENT_GLOBAL_HOME, { mode: 0o700 });
const previous = await import(pathToFileURL(resolve(args[1])).href);
assert.equal(previous.CURRENT_LEDGER_VERSION, 74, 'Previous reader must be the v74 / alpha.63.3 build');
const current = await import('../dist/adapters/core/sqlite-ledger/index.js');
assert.equal(current.CURRENT_LEDGER_VERSION, 75);
const options = { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' };
const path = join(scratch, 'ledger.db'), backups = join(scratch, 'backups'); mkdirSync(backups, { mode: 0o700 });
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function inspect(path, columns) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const tables = columns ?? Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(row => row.name)]));
    const counts = {}, digests = {};
    for (const [name, fields] of Object.entries(tables)) {
      const select = fields.map(quote).join(','), hash = createHash('sha256'); let count = 0;
      const statement = db.prepare(`SELECT ${select} FROM ${quote(name)} ORDER BY ${select}`); statement.setReadBigInts(true);
      for (const row of statement.iterate()) {
        hash.update(JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? { sqliteInteger: value.toString() } : value) + '\n'); count++;
      }
      counts[name] = count; digests[name] = hash.digest('hex');
    }
    const integrity = db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check);
    assert.deepEqual(integrity, ['ok']); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    return { version, columns: tables, counts, digests, integrity };
  } finally { db.close(); }
}
const supplied = new DatabaseSync(resolve(args[0]), { readOnly: true });
try { assert.equal(supplied.prepare('PRAGMA user_version').get().user_version, 74); supplied.prepare('VACUUM INTO ?').run(path); }
finally { supplied.close(); }
const before = inspect(path); const start = performance.now();
const upgrade = current.upgradeExistingLedger(path, options, backups, new Date());
const upgradeMs = performance.now() - start;
assert.equal(upgrade.from, 74); assert.equal(upgrade.to, 75);
const upgraded = new DatabaseSync(path, { readOnly: true });
try { assert.equal(upgraded.prepare('SELECT count(*) AS n FROM model_invocations WHERE resource_key IS NOT NULL').get().n, 0); }
finally { upgraded.close(); }
const after = inspect(path, before.columns); assert.deepEqual(after.counts, before.counts); assert.deepEqual(after.digests, before.digests);
current.openSqliteLedger(path, options, 'forbid').close(); assert.equal(current.upgradeExistingLedger(path, options, backups, new Date()), null);
assert.throws(() => previous.openSqliteLedger(path, options, 'forbid'), { code: 'ATTEMPT_STORE_VERSION' });
const restored = join(scratch, 'restored-v74.db'); copyFileSync(upgrade.backupPath, restored);
previous.openSqliteLedger(restored, options, 'forbid').close();
const backup = inspect(restored); assert.equal(backup.version, 74); assert.deepEqual(backup.counts, before.counts); assert.deepEqual(backup.digests, before.digests);
console.log(JSON.stringify({ environment: { node: process.versions.node, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch }, upgrade: 'ok', from: 74, to: 75, upgradeMs, rowCounts: after.counts, integrity_check: after.integrity,
  unchangedRows: true, reopen: 'ok', preUpgradeBackupReadable: 'ok', alpha64RollbackSupported: false, scratch, backupPath: upgrade.backupPath }, null, 2));
