import { approvalRecordSchema, ApprovalError, encodeCommandProjection, type ApprovalRecord, type ApprovalRequest,
  type RunSnapshot, type ApprovalActor } from '#domain/index.js';
import { sha256, type IntegrityAuthority } from '#platform/index.js';
export function approvalActionDigest(run: RunSnapshot, taskId: string, actor: ApprovalActor, policyRevision: string) {
  if (!run.graph.tasks.some(task => task.id === taskId)) throw new ApprovalError('APPROVAL_INVALID');
  return sha256(encodeCommandProjection('task-admission:1', { identity: run.identity, taskId,
    graph: run.graph, execution: run.execution, actor, policyRevision }));
}
export function approvalRequestDigest(request: ApprovalRequest) { return sha256(encodeCommandProjection('approval-request:1', request)); }
function projection(record: Omit<ApprovalRecord, 'mac'>) {
  return encodeCommandProjection('approval-record:1', { request: record.request, revision: record.revision,
    status: record.status, decision: record.decision, keyId: record.keyId });
}
export function sealApproval(record: Omit<ApprovalRecord, 'mac' | 'keyId'>, authority: IntegrityAuthority): ApprovalRecord {
  const signed = { ...record, keyId: authority.keyId };
  return approvalRecordSchema.parse({ ...signed, mac: authority.sign(projection(signed)) });
}
export function verifyApproval(input: unknown, authority: IntegrityAuthority): ApprovalRecord {
  const parsed = approvalRecordSchema.safeParse(input);
  if (!parsed.success || !authority.verify(projection(parsed.data), parsed.data.mac, parsed.data.keyId)) throw new ApprovalError('APPROVAL_INTEGRITY');
  return parsed.data;
}
