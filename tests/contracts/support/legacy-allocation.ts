import type { DatabaseSync } from 'node:sqlite';

/**
 * Genuine ledgers older than INFLIGHT-FIX were written by builds where a settled `unknown` call kept its concurrency slot
 * (PROVIDERS/A3A). Fixtures that build current records and downgrade them restore that counter, so historical migrations see the
 * ledger such a build actually left (the next service start releases those slots).
 */
export function restoreLegacyInFlight(db: DatabaseSync): void {
  const allocations = db.prepare('SELECT scope_id,allocation_id,record FROM model_invocation_allocations').all() as
    Array<{ scope_id: string; allocation_id: string; record: string }>;
  for (const row of allocations) {
    const held = Number(db.prepare(`SELECT count(*) AS count FROM model_invocations WHERE scope_id=? AND allocation_id=?
      AND state IN ('claimed','unknown')`).get(row.scope_id, row.allocation_id)?.['count']);
    db.prepare('UPDATE model_invocation_allocations SET in_flight=?,record=? WHERE scope_id=? AND allocation_id=?')
      .run(held, JSON.stringify({ ...JSON.parse(row.record), inFlight: held }), row.scope_id, row.allocation_id);
  }
}
