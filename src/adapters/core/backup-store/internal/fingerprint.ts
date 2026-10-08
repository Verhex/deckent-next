import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { refuse } from './files.js';
/** node:sqlite loads only when a ledger is actually opened, so importing the SDK never loads the native module (sqlite-ledger-lazy). */
const nativeSqlite = () => createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
/** Stable table content fingerprint of the immutable online snapshot; identifiers are quoted, all integers read as bigint. */
export function ledgerFingerprint(path: string): string {
  const db = new (nativeSqlite().DatabaseSync)(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const integrity = db.prepare('PRAGMA integrity_check').all().map(row => row['integrity_check']);
    if (integrity.length !== 1 || integrity[0] !== 'ok') return refuse('BACKUP_LEDGER_INVALID');
    const tables: Record<string, { rows: number; sha256: string }> = {};
    for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").iterate()) {
      const name = String(row['name']), quoted = '"' + name.replaceAll('"', '""') + '"';
      const columns = db.prepare(`PRAGMA table_info(${quoted})`).all().length;
      const order = Array.from({ length: columns }, (_, index) => index + 1).join(',');
      const statement = db.prepare(`SELECT * FROM ${quoted}${order ? ` ORDER BY ${order}` : ''}`);
      statement.setReadBigInts(true); statement.setReturnArrays(true);
      let rows = 0; const hash = createHash('sha256');
      for (const data of statement.iterate()) { hash.update(JSON.stringify(data, (_key, value: unknown) => typeof value === 'bigint' ? `${value}n` : value)); rows++; }
      tables[name] = { rows, sha256: hash.digest('hex') };
    }
    return JSON.stringify({ schemaVersion: 1, integrity: 'ok', userVersion: db.prepare('PRAGMA user_version').get()?.['user_version'], tables });
  } catch { return refuse('BACKUP_LEDGER_INVALID'); } finally { db.close(); }
}
