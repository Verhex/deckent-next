import { approvalRecordSchema, ApprovalError, encodeCommandProjection, policySchema, type ApprovalRecord, type ApprovalRequest,
  type RunSnapshot, type ApprovalActor } from '#domain/index.js';
import { sha256, type IntegrityAuthority } from '#platform/index.js';
import type { ApprovalStore } from './store.js';
export function approvalActionDigest(run: RunSnapshot, taskId: string, actor: ApprovalActor, policyInput: unknown) {
  if (!run.graph.tasks.some(task => task.id === taskId)) throw new ApprovalError('APPROVAL_INVALID');
  return sha256(encodeCommandProjection('task-admission:2', { identity: run.identity, taskId,
    graph: run.graph, execution: run.execution, actor, policy: policySchema.parse(policyInput) }));
}
export function approvalRequestDigest(request: ApprovalRequest) { return sha256(encodeCommandProjection('approval-request:1', request)); }
function projection(record: Omit<ApprovalRecord, 'mac'>) {
  return encodeCommandProjection('approval-record:1', { request: record.request, revision: record.revision,
    status: record.status, decision: record.decision, keyId: record.keyId });
}
export function sealApproval(record: Omit<ApprovalRecord, 'mac' | 'keyId'>, authority: IntegrityAuthority): ApprovalRecord {
  const signed = { ...record, keyId: authority.keyId };
  const sealed = approvalRecordSchema.safeParse({ ...signed, mac: authority.sign(projection(signed)) });
  if (!sealed.success) throw new ApprovalError('APPROVAL_INVALID');
  return sealed.data;
}
export function verifyApproval(input: unknown, authority: IntegrityAuthority): ApprovalRecord {
  const parsed = approvalRecordSchema.safeParse(input);
  if (!parsed.success || !authority.verify(projection(parsed.data), parsed.data.mac, parsed.data.keyId)) throw new ApprovalError('APPROVAL_INTEGRITY');
  return parsed.data;
}
/** The one pending → expired transition (lazy expiry, tool-call close, service-start sweep): sealed, conditional on `record`. */
export function expireApproval(store: ApprovalStore, integrity: IntegrityAuthority, record: ApprovalRecord): ApprovalRecord {
  return store.transition(record, sealApproval({ request: record.request, revision: record.revision + 1, status: 'expired', decision: null }, integrity));
}
