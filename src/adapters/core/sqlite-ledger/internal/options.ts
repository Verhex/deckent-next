import { SQLITE_STORAGE_OPTIONS } from '#platform/index.js';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AttemptStoreError } from '#engine/index.js';

export const sqliteLedgerOptionsSchema = SQLITE_STORAGE_OPTIONS;
export type SqliteLedgerOptions = z.infer<typeof sqliteLedgerOptionsSchema>;
/** Minimum bundled SQLite engine version the ledger requires: 3.51.3 fixed the WAL-reset corruption bug present
 * in every SQLite release from 3.7.0 through 3.51.2 (sqlite.org/releaselog/3_51_3.html, 2026-03-13). Node 24.15.0
 * (2026-04-15, 'Krypton' LTS) is the first 24.x release bundling it (nodejs/node commit 952d715028). DEPS-P0. */
export const SQLITE_ENGINE_FLOOR = '3.51.3';
export function sqliteFailure(error: unknown): unknown {
  const code = error && typeof error === 'object' && 'errcode' in error ? error.errcode : null;
  if (typeof code === 'number' && [5, 6].includes(code & 255)) return new AttemptStoreError('ATTEMPT_STORE_BUSY');
  return error;
}
export type LedgerTransactionOptions = Readonly<{ mode?: 'write' | 'read'; join?: boolean; unknown?: () => Error; failure?: (error: unknown) => unknown }>;
/** The one synchronous ledger transaction (`write` = BEGIN IMMEDIATE, `read` = one deferred snapshot; `join` runs inside the caller's open
 * transaction, which owns commit and rollback). Owner B1-9 (a): once COMMIT was attempted, or when ROLLBACK fails, the outcome is unknown
 * until reconciled; every earlier failure is the caller's mapping (default `sqliteFailure`). */
export function ledgerTransaction<T>(db: DatabaseSync, work: () => T, { mode = 'write', join = false, failure = sqliteFailure,
  unknown = () => new AttemptStoreError('ATTEMPT_STORE_OUTCOME_UNKNOWN') }: LedgerTransactionOptions = {}): T {
  if (join && db.isTransaction) return work();
  let active = false, committing = false;
  try { db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN'); active = true; const value = work(); committing = true; db.exec('COMMIT'); return value; }
  catch (error) {
    if (active) { try { db.exec('ROLLBACK'); } catch { throw unknown(); } }
    if (committing) throw unknown();
    throw failure(error);
  }
}
/** One stored JSON column decoded by its schema; a parse failure or a failed `matches` (identity, scope, revision) throws the caller's error. */
export function decodeStored<S extends z.ZodType>(schema: S, stored: unknown, error: () => Error, matches: (value: z.output<S>) => boolean = () => true): z.output<S> {
  try { const value = schema.parse(JSON.parse(String(stored))); if (matches(value)) return value; } catch { /* the caller's error below */ }
  throw error();
}
/** Numeric (not lexical) per-segment compare: '3.9.0' must fail a '3.51.3' floor despite '9' > '5' as characters.
 * A missing or unparsable version (older Node builds without `process.versions.sqlite`, or a non-numeric segment)
 * is treated as below floor — refuse rather than silently trust an engine we cannot identify. */
export function sqliteEngineMeetsFloor(version: string | undefined, floor: string = SQLITE_ENGINE_FLOOR): boolean {
  if (!version) return false;
  const actual = version.split('.').map(Number);
  const required = floor.split('.').map(Number);
  for (let index = 0; index < required.length; index++) {
    const have = actual[index] ?? 0, need = required[index] ?? 0;
    if (!Number.isFinite(have)) return false;
    if (have > need) return true;
    if (have < need) return false;
  }
  return true;
}
/** DEPS-P0: refuse before every ledger open of node:sqlite, before any native module touch or file I/O,
 * when the host's bundled SQLite predates the 3.51.3 WAL-reset corruption fix (SQLITE_ENGINE_FLOOR). Reading
 * `process.versions` never loads the `node:sqlite` binding, so this stays compatible with the adapter's lazy load. */
export function assertSqliteEngineSupported(version: string | undefined): void {
  if (!sqliteEngineMeetsFloor(version)) throw new AttemptStoreError('ATTEMPT_STORE_SQLITE_UNSUPPORTED');
}
