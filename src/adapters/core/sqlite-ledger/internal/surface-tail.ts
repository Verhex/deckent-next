import type { DatabaseSync } from 'node:sqlite';
import { identitySchema } from '#domain/index.js';
import { AttemptStoreError } from '#engine/index.js';
import type { SqliteLedgerOptions } from './options.js';
import { openSqliteLedgerReadOnly } from './connection.js';

export const LEDGER_SURFACE_KINDS = ['approval', 'run', 'worker'] as const;
export type LedgerSurfaceKind = typeof LEDGER_SURFACE_KINDS[number];
/** One new publication row. `missed` is how many earlier revisions of this row were not returned. */
export type LedgerSurfaceRow = { readonly kind: LedgerSurfaceKind; readonly id: string; readonly missed: number };
export interface LedgerSurfaceTail { read(): readonly LedgerSurfaceRow[]; close(): void }

type IdRow = { n: number; id: string };
type RunRow = { run_id: string; revision: number };

function tip(db: DatabaseSync, table: 'approval_outbox' | 'worker_event_logs', scopeId: string): number {
  const sql = table === 'approval_outbox'
    ? 'SELECT coalesce(max(rowid),0) AS n FROM approval_outbox WHERE scope_id=?'
    : 'SELECT coalesce(max(rowid),0) AS n FROM worker_event_logs WHERE scope_id=?';
  const row = db.prepare(sql).get(scopeId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Read-only tail of the ledger publications the runtime already writes. Rows at open are the baseline, not events. */
export function openLedgerSurfaceTail(path: string, options: SqliteLedgerOptions, scopeId: string): LedgerSurfaceTail {
  if (!identitySchema.safeParse(scopeId).success) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  const db = openSqliteLedgerReadOnly(path, options);
  let approvalRow = tip(db, 'approval_outbox', scopeId);
  let workerRow = tip(db, 'worker_event_logs', scopeId);
  const revisions = new Map<string, number>();
  for (const row of db.prepare('SELECT run_id, revision FROM runs WHERE scope_id=?').all(scopeId) as RunRow[]) revisions.set(String(row.run_id), Number(row.revision));
  return {
    read() {
      const found: LedgerSurfaceRow[] = [];
      for (const row of db.prepare('SELECT rowid AS n, approval_id AS id FROM approval_outbox WHERE scope_id=? AND rowid>? ORDER BY rowid').all(scopeId, approvalRow) as IdRow[]) {
        approvalRow = Number(row.n);
        found.push({ kind: 'approval', id: String(row.id), missed: 0 });
      }
      for (const row of db.prepare('SELECT rowid AS n, attempt_id AS id FROM worker_event_logs WHERE scope_id=? AND rowid>? ORDER BY rowid').all(scopeId, workerRow) as IdRow[]) {
        workerRow = Number(row.n);
        found.push({ kind: 'worker', id: String(row.id), missed: 0 });
      }
      for (const row of db.prepare('SELECT run_id, revision FROM runs WHERE scope_id=?').all(scopeId) as RunRow[]) {
        const id = String(row.run_id), revision = Number(row.revision), seen = revisions.get(id);
        if (seen === undefined) { revisions.set(id, revision); found.push({ kind: 'run', id, missed: 0 }); continue; }
        if (revision > seen) {
          const missed = revision - seen - 1;
          revisions.set(id, revision);
          found.push({ kind: 'run', id, missed });
        }
      }
      return found;
    },
    close() { db.close(); },
  };
}
