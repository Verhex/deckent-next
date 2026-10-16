import { describe, expect, it } from 'vitest';
import { candidateBindingSchema, candidateEvidenceSchema, targetQueueRequestSchema, type TargetQueueRecord } from '#domain/index.js';
import { newQueueRecord, TargetQueueApplication, TargetBatchExecutor, prepareTargetBatch, targetBatchDigest, projectTargetQueue,
  type TargetQueueStore, type TargetBatchEffects, type TargetQueueBounds } from '#engine/index.js';
const bounds: TargetQueueBounds = { capacity: 8, perTarget: 4, activeTargets: 2, batchSize: 3, batchWindowMs: 10, leaseMs: 100, verificationTimeoutMs: 100, revalidations: 2 };
const target = { schemaVersion: 1 as const, installationId: 'i', adapter: { id: 'adapter', version: 1 }, resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'entity' } };
function prepared(n: number): TargetQueueRecord {
  const request = targetQueueRequestSchema.parse({ schemaVersion: 1, commandId: 'c' + n,
    identity: { scopeId: 's', runId: 'r', taskId: 't' + n, attemptId: 'a' + n, generation: 1, layoutRevision: 'l' }, actor: { id: 'owner', issuer: 'test', subject: 'owner' },
    target, payloadDigest: 'b'.repeat(64), policyRevision: 'p1', outputDigest: 'c'.repeat(64), acceptedRevision: 1, submittedAt: 1, deadline: 1000 });
  const candidate = candidateBindingSchema.parse({ schemaVersion: 1, target, identity: request.identity, sourceBinding: 'b'.repeat(64), outputDigest: request.outputDigest,
    observedVersion: 'V0', effectiveVersion: 'V' + (n - 1), candidateVersion: 'V' + n, candidateDigest: String(n).repeat(64),
    custodyReceipt: 'e'.repeat(64), criteria: ['f'.repeat(64)], profileFingerprint: 'a'.repeat(64), replacesCommandId: null });
  const verification = candidateEvidenceSchema.parse({ schemaVersion: 1, identity: request.identity, sourceBinding: candidate.sourceBinding, candidateVersion: candidate.candidateVersion,
    candidateDigest: candidate.candidateDigest, custodyReceipt: candidate.custodyReceipt, criteria: candidate.criteria, profileFingerprint: candidate.profileFingerprint,
    evidenceReceipt: 'f'.repeat(64), phase: 'accepted' });
  return { ...newQueueRecord(request, n), revision: 3, state: 'awaiting-confirmation', ownerInstance: 'service', epoch: 1,
    candidate, verification, effectCommandIds: ['publish-' + n, 'adopt-' + n] };
}
function fixture(failure: 'none' | 'unknown' | 'refused' | 'throw' = 'none') {
  const records = [prepared(1), prepared(2), prepared(3)], map = new Map(records.map(r => [r.request.commandId, r]));
  const store: TargetQueueStore = { reserve() { throw new Error('not-used'); }, enqueue() { throw new Error('not-used'); }, load(_scope, id) { return map.get(id) ?? null; },
    list() { return [...map.values()]; }, epoch() { return 1; }, head() { return [...map.values()].find(r => r.state !== 'settled') ?? null; },
    change(before, after) { expect(map.get(before.request.commandId)).toEqual(before); map.set(before.request.commandId, after); return after; } };
  const app = new TargetQueueApplication(store, { async authorize() {}, async validate() {} }, bounds, () => {}), effects: string[] = [];
  const port: TargetBatchEffects = { async fence() { effects.push('fence'); return 'physical-fence'; }, async validate() {},
    async publish(r) { effects.push('publish:' + r.request.commandId); return { state: 'settled', evidenceRefs: ['b'.repeat(64)] }; },
    async adopt(r) { effects.push('adopt:' + r.request.commandId); if (r.request.commandId === 'c2' && failure !== 'none') {
      if (failure === 'throw') throw new Error('lost-reply'); return { state: failure };
    } return { state: 'settled', evidenceRefs: ['c'.repeat(64)] }; }, async lookup() { return { state: 'unknown' }; } };
  const consents: string[] = [], executor = new TargetBatchExecutor(app, store, port, { async assert(batch) { consents.push(batch.operation); } }, () => 10);
  const publish = prepareTargetBatch(records, 'publish', bounds, 10, 500), adopt = prepareTargetBatch(records, 'adopt', bounds, 10, 500);
  return { records, map, store, app, effects, port, consents, executor, publish, adopt };
}
describe('verified prefix batches', () => {
  it('applies each publication/adoption in order with separate exact-batch consents', async () => {
    const f = fixture(), result = await f.executor.execute(f.publish, f.adopt);
    expect(result.settledPrefix).toBe(3); expect(f.effects).toEqual(['fence', 'publish:c1', 'adopt:c1', 'publish:c2', 'adopt:c2', 'publish:c3', 'adopt:c3']);
    expect(new Set(f.consents)).toEqual(new Set(['publish', 'adopt']));
    expect([...f.map.values()].map(r => r.outcome)).toEqual(['adopted', 're-prepared+adopted', 're-prepared+adopted']);
  });
  it.each(['unknown', 'refused', 'throw'] as const)('stops suffix after %s and retains the settled prefix without rollback', async failure => {
    const f = fixture(failure), result = await f.executor.execute(f.publish, f.adopt);
    expect(result.settledPrefix).toBe(1); expect(f.map.get('c1')?.state).toBe('settled'); expect(f.map.get('c2')?.state).toBe('reconciling');
    expect(f.map.get('c3')?.state).toBe('awaiting-confirmation'); expect(f.effects).not.toContain('publish:c3');
    expect(result.items[1]?.published).toBe(true);
    expect((await f.executor.reconcile(f.map.get('c2')!)).state).toBe('reconciling');
    expect(() => f.app.transition(f.map.get('c2')!, { state: 'expired' })).toThrow('QUEUE_CONFLICT');
    expect(() => f.app.transition(f.map.get('c2')!, { state: 'parked' })).toThrow('QUEUE_CONFLICT');
  });
  it('never publishes a failed combined candidate and only offers the accepted prefix', () => {
    const f = fixture(), failed = { ...f.records[1]!, verification: { ...f.records[1]!.verification!, phase: 'failed' as const } };
    expect(prepareTargetBatch([f.records[0]!, failed, f.records[2]!], 'adopt', bounds, 10, 500).items).toHaveLength(1);
    expect(() => prepareTargetBatch([failed], 'adopt', bounds, 10, 500)).toThrow('QUEUE_CONFIRMATION_REQUIRED');
    expect(f.effects).toEqual([]);
  });
  it('binds all candidates, effect commands and target into consent; later arrivals stay outside it', async () => {
    const f = fixture();
    expect(targetBatchDigest({ ...f.adopt, items: [...f.adopt.items, { ...f.adopt.items[0]!, commandId: 'new' }] })).not.toBe(targetBatchDigest(f.adopt));
    await expect(f.executor.execute(f.publish, { ...f.adopt, target: { ...target, resourceBinding: 'f'.repeat(64) } })).rejects.toThrow('QUEUE_CONFLICT');
    expect(f.effects).toEqual([]);
  });
  it('projects generic versions, owner, verified evidence and a reconciliation action without other-scope queue position', () => {
    const record = { ...prepared(1), state: 'reconciling' as const };
    const view = projectTargetQueue(record, { schemaVersion: 1, labelKey: 'record.label', basisKey: 'record.basis', versionKey: 'record.version', prepareActionKey: 'record.prepare' }, 50);
    expect(view).toMatchObject({ nextAction: 'watch-reconciliation', responsibility: 'reconciler', freshness: 'last-known', basis: { observed: 'V0', effective: 'V0', candidate: 'V1' } });
    expect(view).not.toHaveProperty('ordinal'); expect(view).not.toHaveProperty('backlog');
  });
});

it('serializes an exact rollback with its own consent and keeps an uncertain rollback reconciling', async () => {
  const f = fixture(), original = f.records[0]!, rollback = { ...original, request: { ...original.request, operation: 'rollback' as const, sourceCommandId: 'source-ticket' } };
  f.map.set(rollback.request.commandId, rollback);
  const batch = prepareTargetBatch([rollback], 'rollback', bounds, 10, 500);
  expect(batch.items[0]).toMatchObject({ from: 'V1', to: 'V0' });
  f.port.compensate = async () => { f.effects.push('rollback'); return { state: 'settled', evidenceRefs: ['a'.repeat(64)] }; };
  expect((await f.executor.rollback(batch)).settledPrefix).toBe(1);
  expect(f.effects).toEqual(['fence', 'rollback']); expect(f.consents).toEqual(['rollback', 'rollback']);
  expect(f.map.get('c1')).toMatchObject({ state: 'settled', outcome: null });
  const u = fixture(), record = { ...u.records[0]!, request: rollback.request }; u.map.set('c1', record);
  u.port.compensate = async () => ({ state: 'unknown' });
  expect((await u.executor.rollback(prepareTargetBatch([record], 'rollback', bounds, 10, 500))).settledPrefix).toBe(0);
  expect(u.map.get('c1')?.state).toBe('reconciling');
  expect(() => u.app.transition(u.map.get('c1')!, { state: 'parked' })).toThrow('QUEUE_CONFLICT');
});
