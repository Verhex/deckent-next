import type { ApprovalRecord } from '#domain/index.js';
export interface ApprovalReceipt { readonly operation?: 'decide' | 'renew'; readonly scopeId: string; readonly commandId: string; readonly fingerprint: string; readonly record: ApprovalRecord }
/** All mutations atomically persist record, command receipt (when present) and outbox event. */
export interface ApprovalStore {
  load(scopeId: string, approvalId: string): ApprovalRecord | null;
  find(scopeId: string, runId: string, taskId: string, actionDigest: string): ApprovalRecord | null;
  list(scopeId: string, afterId: string | null, limit: number): readonly ApprovalRecord[];
  create(record: ApprovalRecord): ApprovalRecord;
  receipt(scopeId: string, commandId: string): ApprovalReceipt | null;
  renew(previous: ApprovalRecord, next: ApprovalRecord, receipt: ApprovalReceipt): ApprovalRecord;
  transition(previous: ApprovalRecord, next: ApprovalRecord, receipt?: ApprovalReceipt): ApprovalRecord;
}
