import type { DatabaseSync } from 'node:sqlite';
import { workerEventLogSchema, WorkerObservationError, type WorkerEventLog } from '#engine/index.js';

/** Sealed worker event logs (ledger v35). Idempotent: an identical record is accepted again, a different one is a conflict. */
export class SqliteWorkerEventLogs {
  constructor(private readonly db: DatabaseSync) {}
  async loadWorkerEventLog(scopeId: string, attemptId: string): Promise<WorkerEventLog | null> {
    const row = this.db.prepare('SELECT record FROM worker_event_logs WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId);
    if (!row) return null;
    let record: WorkerEventLog;
    try { record = workerEventLogSchema.parse(JSON.parse(String(row.record))); } catch { throw new WorkerObservationError('WORKER_OBSERVATION_INVALID'); }
    if (record.identity.scopeId !== scopeId || record.identity.attemptId !== attemptId) throw new WorkerObservationError('WORKER_OBSERVATION_INVALID');
    return record;
  }
  async saveWorkerEventLog(input: WorkerEventLog): Promise<WorkerEventLog> {
    const record = workerEventLogSchema.parse(input);
    const changed = this.db.prepare('INSERT OR IGNORE INTO worker_event_logs(scope_id,attempt_id,record) VALUES(?,?,?)')
      .run(record.identity.scopeId, record.identity.attemptId, JSON.stringify(record));
    if (changed.changes === 1) return record;
    const existing = await this.loadWorkerEventLog(record.identity.scopeId, record.identity.attemptId);
    if (JSON.stringify(existing) !== JSON.stringify(record)) throw new WorkerObservationError('WORKER_OBSERVATION_INVALID');
    return record;
  }
}
