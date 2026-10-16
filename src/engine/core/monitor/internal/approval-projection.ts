import { approvalRecordSchema, approvalSubject } from '#domain/index.js';
import type { MonitorLedgerApproval } from './evidence.js';
/** Corrupt rows remain diagnostics; adapter-supplied storage failures are not relabelled as bad records. */
export function projectMonitorApprovals(rows: readonly Record<string, unknown>[], limit: number, diagnostics: string[], recordOnly: (error: unknown) => void): MonitorLedgerApproval[] {
  const json = (value: unknown) => { try { return JSON.parse(String(value)) as unknown; } catch { return undefined; } };
  return rows.slice(0, limit).flatMap(row => {
    try {
      const record = approvalRecordSchema.parse(json(row.snapshot)), request = record.request, subject = approvalSubject(request);
      if (request.scopeId !== row.scope_id || request.approvalId !== row.approval_id) throw new Error();
      return [Object.freeze({ status: record.status, scopeId: request.scopeId, approvalId: request.approvalId, subjectKind: subject.kind, runId: subject.kind === 'task' || subject.kind === 'run-create' ? subject.runId : null,
        taskId: subject.kind === 'task' ? subject.taskId : null, summary: request.summary, createdAtMs: request.createdAt, expiresAtMs: request.expiresAt })];
    } catch (error) { recordOnly(error); diagnostics.push(`approval-corrupt:${row.scope_id}/${row.approval_id}`); return []; }
  });
}
