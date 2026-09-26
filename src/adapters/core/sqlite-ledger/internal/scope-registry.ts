import { createRequire } from 'node:module';
import { lstatSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';
import { openSqliteLedger } from './connection.js';
import { CURRENT_LEDGER_VERSION } from './schema.js';
import { sqliteFailure, type SqliteLedgerOptions } from './options.js';

const COMPANY = /^[a-z0-9][a-z0-9-]{0,62}$/;
export interface ScopeRegistration { readonly registered: readonly string[]; readonly pinnedElsewhere: readonly string[] }

/**
 * Read-only lookup of durable scope → company pins. It never creates, migrates or writes: a missing ledger (or one not yet
 * initialized, `user_version` 0) has no pins; an older or newer schema is `ATTEMPT_STORE_VERSION`, never folded into "unknown".
 */
export function readScopeCompanies(path: string, busyTimeoutMs: number, scopeIds: readonly string[]): ReadonlyMap<string, string> {
  try { if (!lstatSync(path).isFile()) return new Map(); } catch { return new Map(); }
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let db: DatabaseSync;
  try { db = new NativeDatabase(path, { timeout: busyTimeoutMs, readOnly: true }); } catch (error) { throw sqliteFailure(error); }
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 0) return new Map();
    if (version !== CURRENT_LEDGER_VERSION) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
    const select = db.prepare('SELECT company_id FROM scope_registry WHERE scope_id=?'); const pins = new Map<string, string>();
    for (const scopeId of new Set(scopeIds)) {
      const company = select.get(scopeId)?.company_id;
      if (typeof company === 'string') pins.set(scopeId, company);
    }
    return pins;
  } catch (error) { throw sqliteFailure(error); }
  finally { db.close(); }
}

/** First-start registration: pins the configured company and the installation's own scopes in one transaction. Insert-only —
 * a scope already pinned to another company is reported, never re-homed. The caller holds endpoint custody. */
export function registerLedgerScopes(path: string, options: SqliteLedgerOptions, companyId: string, scopeIds: readonly string[]): ScopeRegistration {
  if (!COMPANY.test(companyId)) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  const db = openSqliteLedger(path, options, 'forbid');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO companies(company_id) VALUES(?)').run(companyId);
      const insert = db.prepare("INSERT OR IGNORE INTO scope_registry(scope_id,company_id,origin) VALUES(?,?,'start')");
      const pinned = db.prepare('SELECT company_id FROM scope_registry WHERE scope_id=?');
      const registered: string[] = [], pinnedElsewhere: string[] = [];
      for (const scopeId of [...new Set(scopeIds)].sort()) {
        if (Number(insert.run(scopeId, companyId).changes) === 1) registered.push(scopeId);
        else if (pinned.get(scopeId)?.company_id !== companyId) pinnedElsewhere.push(scopeId);
      }
      db.exec('COMMIT');
      return Object.freeze({ registered: Object.freeze(registered), pinnedElsewhere: Object.freeze(pinnedElsewhere) });
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Not started or already closed. */ } throw sqliteFailure(error); }
  } finally { db.close(); }
}
