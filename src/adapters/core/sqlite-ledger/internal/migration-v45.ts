import type { DatabaseSync } from 'node:sqlite';
import { runSnapshotSchema } from '#domain/index.js';
import { AttemptStoreError } from '#engine/index.js';

/** A1/A3 forward-only Run contract v3 -> v4, inside the existing ledger migration transaction.
 * Preserve historical facts, command fingerprints and revisions. Legacy Runs start with `running` state;
 * no historical terminal outcome, timeout, acceptance or operator decision is invented. Service-start
 * upgrade retains a consistent private v44 backup before this step; downgrade requires restoring it. */
export function migrateRunParking(db: DatabaseSync): void {
  for (const table of ['runs', 'run_receipts'] as const) {
    for (const row of db.prepare(`SELECT rowid,scope_id,snapshot${table === 'runs' ? ',run_id,revision' : ''} FROM ${table}`).iterate()) {
      let legacy: Record<string, unknown>;
      try {
        legacy = JSON.parse(String(row.snapshot)) as Record<string, unknown>;
        if (legacy.schemaVersion === 3 && !Object.hasOwn(legacy, 'state')) legacy = { ...legacy, schemaVersion: 4, state: { kind: 'running' } };
        const parsed = runSnapshotSchema.parse(legacy);
        if (parsed.identity.scopeId !== row.scope_id) throw new Error('SCOPE_MISMATCH');
        if (table === 'runs' && (parsed.identity.runId !== row.run_id || parsed.revision !== row.revision)) throw new Error('RUN_ROW_MISMATCH');
      } catch { throw new AttemptStoreError('ATTEMPT_STORE_VERSION'); }
      // Preserve the full authored record rather than a parsed projection (including optional fields).
      db.prepare(`UPDATE ${table} SET snapshot=? WHERE rowid=?`).run(JSON.stringify(legacy), row.rowid!);
    }
  }
}
