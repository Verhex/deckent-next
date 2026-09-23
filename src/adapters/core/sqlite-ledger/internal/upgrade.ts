import { chmodSync, constants, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { SupervisorProfileValidator } from '#engine/index.js';
import { openSqliteLedger } from './connection.js';
import { CURRENT_LEDGER_VERSION, requireLedgerVersion } from './schema.js';
import { sqliteFailure, type SqliteLedgerOptions } from './options.js';

export interface LedgerUpgrade { readonly from: number; readonly to: number; readonly backupPath: string }

/**
 * Service-start upgrade of an existing, older product ledger (owner 2026-09-23, Jev 8bb2a0c7): a consistent
 * versioned copy is written first (`VACUUM INTO`, 0600, never over an existing file), then the ledger is migrated in the
 * normal single transaction. A missing ledger or one already at the current version is left untouched (null).
 * The caller runs this once, before the service accepts connections; clients and read paths never migrate.
 */
export function upgradeExistingLedger(path: string, options: SqliteLedgerOptions, backupDirectory: string, now: Date,
  profiles?: SupervisorProfileValidator): LedgerUpgrade | null {
  try { if (!lstatSync(path).isFile()) return null; } catch { return null; }
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let from: number, backupPath: string;
  const db = new DatabaseSync(path, { timeout: options.busyTimeoutMs, readOnly: false });
  try {
    from = requireLedgerVersion(db, 0);
    if (from === CURRENT_LEDGER_VERSION) return null;
    backupPath = join(backupDirectory, `ledger-v${from}-${now.toISOString().replace(/[:.]/g, '-')}.db`);
    try { lstatSync(backupPath); throw new Error('LEDGER_BACKUP_EXISTS'); } catch (error) { if ((error as Error).message === 'LEDGER_BACKUP_EXISTS') throw error; }
    db.prepare('VACUUM INTO ?').run(backupPath);
    chmodSync(backupPath, constants.S_IRUSR | constants.S_IWUSR);
  } catch (error) { throw sqliteFailure(error); }
  finally { db.close(); }
  openSqliteLedger(path, options, 'allow', profiles).close();
  return Object.freeze({ from, to: CURRENT_LEDGER_VERSION, backupPath });
}
