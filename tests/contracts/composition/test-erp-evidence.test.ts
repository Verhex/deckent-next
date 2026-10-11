import { expect, it } from 'vitest';
import { approvalRecordSchema, effectRecordSchema } from '#domain/index.js';
import { config } from '../../fixtures/test-erp/fixture.js';
import { correlateEvidence } from '../../fixtures/test-erp/evidence.js';

function fixture() {
  const version = `"${config.versionPrefix}${config.initialVersion + 1}"`;
  const key = 'a'.repeat(64), digest = 'b'.repeat(64), actionDigest = 'c'.repeat(64);
  const command = { schemaVersion: 1, commandId: 'proof', scopeId: config.scopeId, operation: config.operations.approve,
    target: { kind: config.targetKind, id: config.recordId }, idempotencyKey: config.keyPrefix, input: null, expectedVersion: 'initial' };
  const record = effectRecordSchema.parse({ intent: { schemaVersion: 1, command, descriptor: { schemaVersion: 1,
    operation: command.operation, targetKind: command.target.kind, effectClass: 'write', approval: 'required', precondition: 'record-version',
    compensation: config.operations.undo, inputMaxBytes: config.http.inputMaxBytes }, actor: { id: 'actor', issuer: 'test', subject: 'author' },
    idempotencyKeyHash: digest, inputDigest: digest, wireKey: key, targetBinding: digest, approval: { approvalId: 'card', actionDigest } },
    sequence: 1, state: 'settled', evidence: { kind: 'idempotency-record', version, observedAt: 1 }, refusal: null });
  // Data only: this record is used to test the evidence collector, never as an authenticated decision in a product run.
  const approval = approvalRecordSchema.parse({ request: { schemaVersion: 2, approvalId: 'card', scopeId: config.scopeId,
    subject: { kind: 'operation', operation: command.operation, target: command.target, commandId: command.commandId,
      inputDigest: digest, targetBinding: digest, expectedVersion: command.expectedVersion, compensates: null },
    requester: record.intent.actor, actionDigest, policyRevision: config.policy.revision, summary: 'Collector input', createdAt: 0, expiresAt: 10 },
    revision: 1, status: 'decided', decision: { commandId: 'answer', decision: 'allow', actor: record.intent.actor, sessionId: 'collector',
      channel: 'local-cli', reason: 'Collector input', decidedAt: 1, requestDigest: digest, commandDigest: digest, idempotencyKeyHash: digest }, keyId: 'collector', mac: digest });
  return { record, approval, writes: [{ key, after: { version: config.initialVersion + 1 } }], keys: new Map([[key, version]]) };
}
it('correlates settlement, exactly one server write and its matching approved command and digest', () => {
  const f = fixture();
  expect(correlateEvidence([{ id: 'proof', record: f.record }], f.writes, f.keys, [f.approval])).toEqual([
    expect.objectContaining({ commandId: 'proof', state: 'settled', serverWriteCount: 1, approvalId: 'card',
      actionDigest: f.approval.request.actionDigest, approvalActionDigest: f.approval.request.actionDigest })]);
});
it('rejects a settlement when the server has zero or two matching writes', () => {
  const f = fixture();
  for (const writes of [[], [...f.writes, ...f.writes]]) {
    expect(() => correlateEvidence([{ id: 'proof', record: f.record }], writes, f.keys, [f.approval])).toThrow('settlement/server-write mismatch');
  }
});
it('rejects a mismatched server version and an unrelated or missing approval', () => {
  const f = fixture();
  expect(() => correlateEvidence([{ id: 'proof', record: f.record }], f.writes, new Map(), [f.approval])).toThrow('settlement/idempotency mismatch');
  expect(() => correlateEvidence([{ id: 'proof', record: f.record }], f.writes, f.keys, [])).toThrow('settlement/approval mismatch');
  const other = approvalRecordSchema.parse({ ...f.approval, request: { ...f.approval.request, actionDigest: 'd'.repeat(64) } });
  expect(() => correlateEvidence([{ id: 'proof', record: f.record }], f.writes, f.keys, [other])).toThrow('settlement/approval mismatch');
});
it('rejects a foreign effect identity and an orphan server write', () => {
  const f = fixture();
  expect(() => correlateEvidence([{ id: 'other', record: f.record }], f.writes, f.keys, [f.approval])).toThrow('effect identity mismatch');
  expect(() => correlateEvidence([], f.writes, f.keys, [])).toThrow('server write lacks exactly one effect intent');
});
it('retains unknown as observation without manufacturing settlement or acceptance', () => {
  const f = fixture();
  const unknown = effectRecordSchema.parse({ ...f.record, state: 'unknown', evidence: null });
  expect(correlateEvidence([{ id: 'proof', record: unknown }], f.writes, f.keys, [])).toEqual([
    expect.objectContaining({ state: 'unknown', settlementVersion: null, serverWriteCount: 1 })]);
});
