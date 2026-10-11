import type { ApprovalRecord, EffectRecord } from '#domain/index.js';
import config from './config.json' with { type: 'json' };

type Write = { key: string; after: { version: number } };
/** Fixture-only correlation, not a Core evaluator or a Task acceptance decision. */
export function correlateEvidence(effects: readonly { id: string; record: EffectRecord | null }[], writes: readonly Write[],
  idempotency: ReadonlyMap<string, string>, approvals: readonly ApprovalRecord[]) {
  const correlations = effects.map(({ id, record }) => {
    if (!record) return { commandId: id, state: 'absent' };
    if (record.intent.command.commandId !== id || record.intent.command.scopeId !== config.scopeId) throw new Error(`fixture effect identity mismatch: ${id}`);
    const key = record.intent.wireKey;
    const matchingWrites = writes.filter(write => write.key === key);
    const approval = approvals.find(value => value.request.approvalId === record.intent.approval?.approvalId);
    if (record.state === 'settled') {
      if (!key || idempotency.get(key) !== record.evidence?.version) throw new Error(`fixture settlement/idempotency mismatch: ${id}`);
      if (record.intent.descriptor.effectClass !== 'read' && (matchingWrites.length !== 1
        || record.evidence?.version !== `"${config.versionPrefix}${matchingWrites[0]!.after.version}"`)) {
        throw new Error(`fixture settlement/server-write mismatch: ${id}`);
      }
      if (record.intent.approval && (!approval || approval.decision?.decision !== 'allow'
        || approval.request.actionDigest !== record.intent.approval.actionDigest
        || approval.request.schemaVersion === 1 || approval.request.subject.kind !== 'operation'
        || approval.request.scopeId !== record.intent.command.scopeId || approval.request.subject.commandId !== id
        || approval.request.subject.inputDigest !== record.intent.inputDigest
        || JSON.stringify(approval.request.subject.operation) !== JSON.stringify(record.intent.command.operation)
        || JSON.stringify(approval.request.subject.target) !== JSON.stringify(record.intent.command.target))) {
        throw new Error(`fixture settlement/approval mismatch: ${id}`);
      }
    }
    return { commandId: id, state: record.state, sequence: record.sequence, inputDigest: record.intent.inputDigest,
      wireKey: key ?? null, settlementVersion: record.evidence?.version ?? null, serverVersion: key ? idempotency.get(key) ?? null : null,
      serverWriteCount: matchingWrites.length, approvalId: record.intent.approval?.approvalId ?? null,
      actionDigest: record.intent.approval?.actionDigest ?? null, approvalActionDigest: approval?.request.actionDigest ?? null };
  });
  // A write without any corresponding intent is a broken custody chain even if all recorded intents looked valid.
  if (writes.some(write => effects.filter(value => value.record?.intent.wireKey === write.key).length !== 1)) {
    throw new Error('fixture server write lacks exactly one effect intent');
  }
  return correlations;
}
