import type { DatabaseSync } from 'node:sqlite';
import { approvalRecordSchema, approvalSubject, ApprovalError, type ApprovalRecord } from '#domain/index.js';
import type { ApprovalStore, ApprovalReceipt } from '#engine/index.js';
import { openSqliteLedger, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';

/** Uses the shared ledger; callers may supply the current reservation transaction's connection. */
export class SqliteApprovalStore implements ApprovalStore {
  constructor(private readonly db: DatabaseSync) {}
  private decode(input: unknown): ApprovalRecord {
    try { return approvalRecordSchema.parse(JSON.parse(String(input))); } catch { throw new ApprovalError('APPROVAL_INTEGRITY'); }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private event(record: ApprovalRecord) {
    this.db.prepare('INSERT INTO approval_outbox(scope_id,approval_id,revision,snapshot) VALUES(?,?,?,?)')
      .run(record.request.scopeId, record.request.approvalId, record.revision, JSON.stringify(record));
  }
  load(scopeId: string, approvalId: string) {
    const row = this.db.prepare('SELECT snapshot,revision FROM approvals WHERE scope_id=? AND approval_id=?').get(scopeId, approvalId);
    if (!row) return null; const record = this.decode(row.snapshot);
    if (record.request.scopeId !== scopeId || record.request.approvalId !== approvalId || record.revision !== row.revision) throw new ApprovalError('APPROVAL_INTEGRITY');
    return record;
  }
  find(scopeId: string, runId: string, taskId: string, actionDigest: string) {
    const row = this.db.prepare("SELECT approval_id FROM approvals WHERE scope_id=? AND subject_kind='task' AND run_id=? AND task_id=? AND action_digest=? AND current=1")
      .get(scopeId, runId, taskId, actionDigest);
    if (!row) return null;
    const record = this.load(scopeId, String(row.approval_id)), subject = record && approvalSubject(record.request);
    if (!record || subject?.kind !== 'task' || subject.runId !== runId || subject.taskId !== taskId || record.request.actionDigest !== actionDigest) {
      throw new ApprovalError('APPROVAL_INTEGRITY');
    }
    return record;
  }
  findToolCall(scopeId: string, actionDigest: string) {
    const row = this.db.prepare("SELECT approval_id FROM approvals WHERE scope_id=? AND subject_kind='agent-tool-call' AND action_digest=? AND current=1")
      .get(scopeId, actionDigest);
    if (!row) return null;
    const record = this.load(scopeId, String(row.approval_id));
    if (!record || approvalSubject(record.request).kind !== 'agent-tool-call' || record.request.actionDigest !== actionDigest) throw new ApprovalError('APPROVAL_INTEGRITY');
    return record;
  }
  /** Row columns of a request: the subject kind and, for a task, its run and task. */
  private columns(record: ApprovalRecord) {
    const subject = approvalSubject(record.request);
    return subject.kind === 'task' ? ['task', subject.runId, subject.taskId] as const : ['agent-tool-call', null, null] as const;
  }
  list(scopeId: string, afterId: string | null, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new ApprovalError('APPROVAL_INVALID');
    return this.db.prepare('SELECT approval_id FROM approvals WHERE scope_id=? AND (? IS NULL OR approval_id>?) ORDER BY approval_id LIMIT ?')
      .all(scopeId, afterId, afterId, limit).map(row => this.load(scopeId, String(row.approval_id))!);
  }
  create(input: ApprovalRecord): ApprovalRecord {
    const record = approvalRecordSchema.parse(input);
    if (record.status !== 'pending') throw new ApprovalError('APPROVAL_INVALID');
    return this.transaction(() => {
      const r = record.request, [kind, runId, taskId] = this.columns(record);
      const existing = kind === 'task' ? this.find(r.scopeId, runId!, taskId!, r.actionDigest) : this.findToolCall(r.scopeId, r.actionDigest);
      if (existing) return existing;
      this.db.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot) VALUES(?,?,?,?,?,?,?,?)')
        .run(r.scopeId, r.approvalId, kind, runId, taskId, r.actionDigest, record.revision, JSON.stringify(record));
      this.event(record); return record;
    });
  }
  receipt(scopeId: string, commandId: string): ApprovalReceipt | null {
    const row = this.db.prepare('SELECT operation,fingerprint,snapshot FROM approval_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null; const record = this.decode(row.snapshot);
    const binding = row.operation === 'decide' ? record.decision : row.operation === 'renew' ? record.request.renewal : null;
    if (record.request.scopeId !== scopeId || binding?.commandId !== commandId || binding.commandDigest !== row.fingerprint) throw new ApprovalError('APPROVAL_INTEGRITY');
    return { operation: row.operation as 'decide' | 'renew', scopeId, commandId, fingerprint: String(row.fingerprint), record };
  }
  renew(previous: ApprovalRecord, next: ApprovalRecord, receipt: ApprovalReceipt): ApprovalRecord {
    approvalRecordSchema.parse(next);
    // A tool-call approval is single use for its exact call: it is never renewed; the next call opens its own.
    if (approvalSubject(previous.request).kind !== 'task' || approvalSubject(next.request).kind !== 'task') throw new ApprovalError('APPROVAL_INVALID');
    if (next.status !== 'pending' || next.request.renewal?.previousApprovalId !== previous.request.approvalId
      || next.request.scopeId !== previous.request.scopeId || next.request.actionDigest !== previous.request.actionDigest
      || !(previous.status === 'expired' || (previous.status === 'decided' && previous.decision?.decision === 'deny'))) throw new ApprovalError('APPROVAL_CONFLICT');
    return this.transaction(() => {
      const replay = this.receipt(receipt.scopeId, receipt.commandId);
      if (replay) {
        if (replay.operation !== 'renew' || replay.fingerprint !== receipt.fingerprint) throw new ApprovalError('APPROVAL_CONFLICT');
        return replay.record;
      }
      if (JSON.stringify(this.load(previous.request.scopeId, previous.request.approvalId)) !== JSON.stringify(previous)) throw new ApprovalError('APPROVAL_CONFLICT');
      const retired = this.db.prepare('UPDATE approvals SET current=0 WHERE scope_id=? AND approval_id=? AND current=1')
        .run(previous.request.scopeId, previous.request.approvalId);
      if (retired.changes !== 1) throw new ApprovalError('APPROVAL_CONFLICT');
      const r = next.request, [kind, runId, taskId] = this.columns(next);
      this.db.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot) VALUES(?,?,?,?,?,?,?,?)')
        .run(r.scopeId, r.approvalId, kind, runId, taskId, r.actionDigest, next.revision, JSON.stringify(next));
      this.db.prepare('INSERT INTO approval_receipts(scope_id,command_id,operation,fingerprint,snapshot) VALUES(?,?,?,?,?)')
        .run(receipt.scopeId, receipt.commandId, 'renew', receipt.fingerprint, JSON.stringify(next));
      this.event(next); return next;
    });
  }
  transition(previous: ApprovalRecord, next: ApprovalRecord, receipt?: ApprovalReceipt): ApprovalRecord {
    approvalRecordSchema.parse(next);
    if (previous.status !== 'pending' || next.status === 'pending' || next.revision !== previous.revision + 1
      || JSON.stringify(previous.request) !== JSON.stringify(next.request)) throw new ApprovalError('APPROVAL_CONFLICT');
    return this.transaction(() => {
      if (receipt) {
        const replay = this.receipt(receipt.scopeId, receipt.commandId);
        if (replay) {
          if (replay.fingerprint !== receipt.fingerprint) throw new ApprovalError('APPROVAL_CONFLICT');
          return replay.record;
        }
      }
      const current = this.load(previous.request.scopeId, previous.request.approvalId);
      if (JSON.stringify(current) !== JSON.stringify(previous)) throw new ApprovalError('APPROVAL_CONFLICT');
      const updated = this.db.prepare('UPDATE approvals SET revision=?,snapshot=? WHERE scope_id=? AND approval_id=? AND revision=?')
        .run(next.revision, JSON.stringify(next), next.request.scopeId, next.request.approvalId, previous.revision);
      if (updated.changes !== 1) throw new ApprovalError('APPROVAL_CONFLICT');
      if (receipt) this.db.prepare('INSERT INTO approval_receipts(scope_id,command_id,operation,fingerprint,snapshot) VALUES(?,?,?,?,?)')
        .run(receipt.scopeId, receipt.commandId, receipt.operation ?? 'decide', receipt.fingerprint, JSON.stringify(next));
      this.event(next); return next;
    });
  }
}
export function openSqliteApprovalStore(path: string, options: SqliteLedgerOptions, migration: 'allow' | 'forbid' = 'forbid') {
  const db = openSqliteLedger(path, options, migration);
  return { store: new SqliteApprovalStore(db), close: () => db.close() };
}
