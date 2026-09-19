import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { immutableJsonObjectSchema } from '#domain/index.js';
import { executionPoolSchema, type ExecutionPool } from '#engine/index.js';
import { migrateLedger, CURRENT_LEDGER_VERSION } from './schema.js';
import { sqliteAttemptOptionsSchema, type SqliteAttemptOptions } from './options.js';
import { SqliteExecutionPools } from './pools.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const ownershipSchema = z.object({
  schemaVersion: z.literal(1), transactionId: z.string().min(1).max(256),
  planDigest: hex, profileDigest: hex, proposalDigest: hex,
}).strict().readonly();
export type InstallationLedgerOwnership = z.infer<typeof ownershipSchema>;
export type InstallationLedgerErrorCode = 'INSTALLATION_LEDGER_INVALID' | 'INSTALLATION_LEDGER_CONFLICT'
  | 'INSTALLATION_LEDGER_CORRUPT' | 'INSTALLATION_LEDGER_UNAVAILABLE' | 'INSTALLATION_LEDGER_OUTCOME_UNKNOWN';
export class InstallationLedgerError extends Error {
  constructor(readonly code: InstallationLedgerErrorCode) { super(code); this.name = 'InstallationLedgerError'; }
}

function record(ownership: InstallationLedgerOwnership, pool: ExecutionPool): string {
  return JSON.stringify({ schemaVersion: 1, ownership, pool });
}
function inputs(ownershipInput: unknown, poolInput: unknown) {
  const copiedOwnership = immutableJsonObjectSchema.safeParse(ownershipInput), copiedPool = immutableJsonObjectSchema.safeParse(poolInput);
  const parsedOwnership = copiedOwnership.success ? ownershipSchema.safeParse(copiedOwnership.data) : copiedOwnership;
  const parsedPool = copiedPool.success ? executionPoolSchema.safeParse(copiedPool.data) : copiedPool;
  if (!parsedOwnership.success || !parsedPool.success) throw new InstallationLedgerError('INSTALLATION_LEDGER_INVALID');
  return { ownership: parsedOwnership.data, pool: parsedPool.data, encoded: record(parsedOwnership.data, parsedPool.data) };
}
function userObjects(db: DatabaseSync): readonly string[] {
  const rows = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return rows.map(row => String(row.name));
}
function exactReplay(db: DatabaseSync, expected: string, pool: ExecutionPool): void {
  let rows;
  try { rows = db.prepare('SELECT singleton,record FROM installation_ownership').all(); }
  catch { throw new InstallationLedgerError('INSTALLATION_LEDGER_CONFLICT'); }
  if (rows.length !== 1 || rows[0]?.singleton !== 1 || rows[0]?.record !== expected) throw new InstallationLedgerError('INSTALLATION_LEDGER_CONFLICT');
  let stored: unknown;
  try { stored = db.prepare('SELECT policy FROM execution_pools WHERE pool_id=?').get(pool.poolId)?.policy; }
  catch { throw new InstallationLedgerError('INSTALLATION_LEDGER_CORRUPT'); }
  if (stored !== JSON.stringify(pool)) throw new InstallationLedgerError('INSTALLATION_LEDGER_CONFLICT');
}

/** Installer-only ledger initialization. Filesystem path custody and permissions remain composition's responsibility. */
export async function initializeInstallationLedger(path: string, options: SqliteAttemptOptions, ownershipInput: unknown, poolInput: unknown) {
  const copiedOptions = immutableJsonObjectSchema.safeParse(options);
  const parsedOptions = copiedOptions.success ? sqliteAttemptOptionsSchema.safeParse(copiedOptions.data) : copiedOptions;
  if (typeof path !== 'string' || !path || !parsedOptions.success) {
    throw new InstallationLedgerError('INSTALLATION_LEDGER_INVALID');
  }
  const { ownership, pool, encoded } = inputs(ownershipInput, poolInput);
  let db: DatabaseSync;
  try { const sqlite = await import('node:sqlite'); db = new sqlite.DatabaseSync(path, { timeout: parsedOptions.data.busyTimeoutMs }); }
  catch { throw new InstallationLedgerError('INSTALLATION_LEDGER_UNAVAILABLE'); }
  let active = false, commitAttempted = false;
  try {
    const journal = { wal: 'PRAGMA journal_mode=WAL', delete: 'PRAGMA journal_mode=DELETE' } as const;
    const durability = { full: 'PRAGMA synchronous=FULL', extra: 'PRAGMA synchronous=EXTRA' } as const;
    db.exec(durability[parsedOptions.data.durability]);
    db.exec('BEGIN IMMEDIATE'); active = true;
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 0) {
      if (userObjects(db).length !== 0) throw new InstallationLedgerError('INSTALLATION_LEDGER_CONFLICT');
      migrateLedger(db, 'allow');
      db.prepare('INSERT INTO installation_ownership(singleton,record) VALUES(1,?)').run(encoded);
      new SqliteExecutionPools(db).create(pool);
    } else if (version === CURRENT_LEDGER_VERSION) exactReplay(db, encoded, pool);
    else throw new InstallationLedgerError('INSTALLATION_LEDGER_CONFLICT');
    commitAttempted = true; db.exec('COMMIT'); active = false;
    if (db.prepare(journal[parsedOptions.data.journalMode]).get()?.journal_mode !== parsedOptions.data.journalMode) {
      throw new InstallationLedgerError('INSTALLATION_LEDGER_OUTCOME_UNKNOWN');
    }
    return Object.freeze({ ownership, pool });
  } catch (error) {
    if (active) {
      try { db.exec('ROLLBACK'); active = false; }
      catch { throw new InstallationLedgerError('INSTALLATION_LEDGER_OUTCOME_UNKNOWN'); }
    }
    if (commitAttempted) throw new InstallationLedgerError('INSTALLATION_LEDGER_OUTCOME_UNKNOWN');
    if (error instanceof InstallationLedgerError) throw error;
    throw new InstallationLedgerError('INSTALLATION_LEDGER_UNAVAILABLE');
  } finally { try { db.close(); } catch { /* The committed result remains authoritative. */ } }
}

/** Read-only final/replay verification. It never creates a path, starts a write transaction, or changes PRAGMAs. */
export async function verifyInstallationLedger(path: string, ownershipInput: unknown, poolInput: unknown) {
  if (typeof path !== 'string' || !path) throw new InstallationLedgerError('INSTALLATION_LEDGER_INVALID');
  const { ownership, pool, encoded } = inputs(ownershipInput, poolInput);
  let db: DatabaseSync;
  try { const sqlite = await import('node:sqlite'); db = new sqlite.DatabaseSync(path, { readOnly: true }); }
  catch { throw new InstallationLedgerError('INSTALLATION_LEDGER_UNAVAILABLE'); }
  try {
    if (db.prepare('PRAGMA user_version').get()?.user_version !== CURRENT_LEDGER_VERSION) {
      throw new InstallationLedgerError('INSTALLATION_LEDGER_CONFLICT');
    }
    exactReplay(db, encoded, pool);
    return Object.freeze({ ownership, pool });
  } catch (error) {
    if (error instanceof InstallationLedgerError) throw error;
    throw new InstallationLedgerError('INSTALLATION_LEDGER_UNAVAILABLE');
  } finally { try { db.close(); } catch { /* Read-only verification has no uncertain durable outcome. */ } }
}
