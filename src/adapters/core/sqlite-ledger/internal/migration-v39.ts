import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';

// H34 S1 (owner 2026-09-27: ledger company column). One company per scope: `scope_id` is the key, pins are insert-only, and the
// company of every scope-partitioned record is the join through its `scope_id`. IF NOT EXISTS: a real ledger below v39 never has
// these tables; a foreign same-name table with another shape fails the backfill and rolls the single migration transaction back.
const SCOPE_REGISTRY_SQL = `CREATE TABLE IF NOT EXISTS companies(company_id TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE IF NOT EXISTS scope_registry(scope_id TEXT PRIMARY KEY NOT NULL,
    company_id TEXT NOT NULL REFERENCES companies(company_id),origin TEXT NOT NULL CHECK(origin IN('migration','start')));`;
const COMPANY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TABLE = /^[a-z][a-z0-9_]*$/;

/** Creates the registry and pins every scope already present in a scope-partitioned table to `companyId` (the configured
 * company at the upgrading service start). A ledger without scoped rows gains empty tables; no company is invented. */
export function migrateScopeRegistry(db: DatabaseSync, companyId: string): void {
  if (!COMPANY.test(companyId)) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  db.exec(SCOPE_REGISTRY_SQL);
  const tables = db.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN('scope_registry','companies')
    AND EXISTS(SELECT 1 FROM pragma_table_info(sqlite_schema.name) WHERE name='scope_id') ORDER BY name`).all().map(row => String(row.name));
  if (tables.some(table => !TABLE.test(table))) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  if (!tables.length) return;
  const scoped = tables.map(table => `SELECT scope_id FROM ${table}`).join(' UNION ');
  if (!db.prepare(`SELECT 1 AS found FROM (${scoped}) LIMIT 1`).get()) return;
  db.prepare('INSERT OR IGNORE INTO companies(company_id) VALUES(?)').run(companyId);
  db.prepare(`INSERT OR IGNORE INTO scope_registry(scope_id,company_id,origin) SELECT scope_id,?,'migration' FROM (${scoped})`).run(companyId);
}
