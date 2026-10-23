import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { CatalogEvolutionError, encodeDeckentJson, type JsonValue } from '#domain/index.js';
import { catalogEvolutionPassSchema, type CatalogEvolutionPass, type CatalogEvolutionStore } from '#engine/index.js';
import { sha256 } from '#platform/index.js';
import { openSqliteLedger, readCurrentMetricRows, requireLedgerVersion, CATALOG_EVOLUTION_LEDGER_VERSION, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';

const corrupt = () => new CatalogEvolutionError('CATALOG_EVOLUTION_CORRUPT');
/**
 * Core SQLite adapter of the S8-2 pass store on the shared ledger (v69). The pass record is rebuildable state, sealed by its own digest (a tampered
 * record is corrupt, never a silent restart); its position only moves forward and is never deleted (ledger triggers). Metric rows come from the
 * digest-checked metrics reader of the same ledger.
 */
class SqliteCatalogEvolutionStore implements CatalogEvolutionStore {
  constructor(private readonly db: DatabaseSync) {}
  async recentRows(scopeId: string, limit: number, upTo?: number) { return readCurrentMetricRows(this.db, scopeId, limit, { upTo: upTo ?? null }); }
  async rowsAfter(scopeId: string, after: number, limit: number) { return readCurrentMetricRows(this.db, scopeId, limit, { after }); }
  async lastPass(scopeId: string): Promise<CatalogEvolutionPass | null> {
    const row = this.db.prepare('SELECT position,record FROM catalog_evolution_positions WHERE scope_id=?').get(scopeId);
    if (!row) return null;
    try {
      const sealed = JSON.parse(String(row['record'])) as { record: unknown; digest: string }, record = catalogEvolutionPassSchema.parse(sealed.record);
      if (sha256(encodeDeckentJson(record as unknown as JsonValue)) !== sealed.digest || record.scopeId !== scopeId || record.position !== row['position']) throw corrupt();
      return record;
    } catch { throw corrupt(); }
  }
  async recordPass(record: CatalogEvolutionPass, expected: number) {
    const value = catalogEvolutionPassSchema.parse(record), sealed = JSON.stringify({ record: value, digest: sha256(encodeDeckentJson(value as unknown as JsonValue)) });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT position FROM catalog_evolution_positions WHERE scope_id=?').get(value.scopeId);
      if (Number(current?.['position'] ?? 0) !== expected || value.previousPosition !== expected || value.position <= expected) throw new CatalogEvolutionError('CATALOG_EVOLUTION_POSITION_CONFLICT');
      this.db.prepare(current ? 'UPDATE catalog_evolution_positions SET position=?,record=? WHERE scope_id=?' : 'INSERT INTO catalog_evolution_positions(position,record,scope_id) VALUES(?,?,?)')
        .run(value.position, sealed, value.scopeId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
/** Reads never migrate or take the write lock; the pass (the runtime service) is the only writer. */
export function openSqliteCatalogEvolutionStore(path: string, options: SqliteLedgerOptions, access: 'read' | 'write'): CatalogEvolutionStore {
  if (access === 'write') return new SqliteCatalogEvolutionStore(openSqliteLedger(path, options, 'forbid'));
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new NativeDatabase(path, { readOnly: true, timeout: options.busyTimeoutMs });
  try { requireLedgerVersion(db, CATALOG_EVOLUTION_LEDGER_VERSION); return new SqliteCatalogEvolutionStore(db); } catch (error) { db.close(); throw error; }
}
