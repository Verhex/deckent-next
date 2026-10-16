import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { identitySchema, PROVIDER_SPEND_SCOPE_BUDGET_ID } from '#domain/index.js';
import { RuntimeEventsError, captureRuntimeObservation, type RuntimeObservationTable, type RuntimeObservationStoredRow, type RuntimeEventsSelection, type RuntimeObservationCapture } from '#engine/index.js';
import type { RuntimeEventsSettings, IntegrityAuthority } from '#platform/index.js';
import { openSqliteLedgerReadOnly, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';

/** A bounded read transaction over the same canonical sources as surface-tail, extended to Attempt and usage.
 * No trigger, migration, write, or claim of complete commit history. All source watermarks stay adapter-private. */
export function openRuntimeObservationLedger(path: string, options: SqliteLedgerOptions, query: RuntimeEventsSelection, limits: RuntimeEventsSettings, integrity?: IntegrityAuthority) {
  if (query.topics.includes('approval') && !integrity) throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE');
  const db = openSqliteLedgerReadOnly(path, options);
  let closed = false, version: number | null = null;
  let retained: RuntimeObservationCapture | null = null;
  return {
    capture(now: number): RuntimeObservationCapture {
      if (closed) throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE');
      const currentVersion = Number(db.prepare('PRAGMA data_version').get()?.data_version);
      if (retained && currentVersion === version) return { ...retained, rows: retained.rows.map(row => row.record.entity === 'approval' && row.record.status === 'pending'
        && row.record.expiresAt! <= now ? { ...row, watermark: row.watermark + ':expired', record: { ...row.record, status: 'expired', observedAt: now } } : row) };
      db.exec('BEGIN');
      try {
        retained = captureRuntimeObservation(query, limits, now, integrity, {
          page: (table, scopeId, after, limit, bytes) => pageRows(db, table, scopeId, after, limit, bytes),
          planInvocation: (scopeId, invocationId, bytes) => db.prepare('SELECT length(CAST(record AS BLOB)) AS size, CASE WHEN length(CAST(record AS BLOB))<=? THEN record END AS value FROM model_invocations WHERE scope_id=? AND invocation_id=?')
            .get(bytes, scopeId, invocationId) as { size: number; value: string | null } | undefined,
          now: () => performance.now(),
        });
        version = currentVersion; return retained;
      } catch (error) { if (error instanceof RuntimeEventsError) throw error; throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE'); }
      finally { db.exec('ROLLBACK'); }
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
function pageRows(db: DatabaseSync, table: RuntimeObservationTable, scopeId: string, after: number, limit: number, bytes: number): RuntimeObservationStoredRow[] {
  const revision = ['runs', 'attempts', 'approvals', 'provider_spend_accounts'].includes(table.name) ? ',revision' : '';
  const state = table.name === 'model_invocations' ? ',state' : '';
  const checkpoint = table.name === 'provider_spend_accounts' ? ',digest,reservation_count' : '';
  const watermark = table.name === 'approvals' ? ',(SELECT max(rowid) FROM approval_outbox o WHERE o.scope_id=approvals.scope_id AND o.approval_id=approvals.approval_id) AS watermark' : '';
  const params: SQLInputValue[] = [bytes, ...(table.scope === false ? [] : [scopeId]), after, limit];
  const result: RuntimeObservationStoredRow[] = []; let used = 0;
  for (const value of db.prepare(`SELECT rowid AS n,length(CAST(${table.field} AS BLOB)) AS size, CASE WHEN length(CAST(${table.field} AS BLOB))<=? THEN ${table.field} END AS value${revision}${state}${watermark}${checkpoint}
    FROM ${table.name} WHERE ${table.scope === false ? '' : 'scope_id=? AND '}rowid>? ORDER BY rowid LIMIT ?`).iterate(...params)) {
    const row = value as RuntimeObservationStoredRow; if (row.value === null || used + row.size > bytes) throw new RuntimeEventsError('RUNTIME_EVENTS_TOO_LARGE');
    used += row.size; result.push(row);
  }
  return result;
}

/** Only a selector, under an already admitted peer scope. The existing spend authorizer still gates all account data. */
export function readRuntimeObservationBudget(path: string, options: SqliteLedgerOptions, scopeId: string) {
  const db = openSqliteLedgerReadOnly(path, options);
  try {
    const row = db.prepare("SELECT json_extract(record,'$.budget.budgetId') AS id,json_extract(record,'$.budget.revision') AS revision FROM provider_spend_accounts WHERE scope_id=?").get(scopeId);
    return { scopeId, budgetId: row ? identitySchema.parse(row.id) : PROVIDER_SPEND_SCOPE_BUDGET_ID, budgetRevision: row ? Number(row.revision) : 1 };
  } finally { db.close(); }
}
