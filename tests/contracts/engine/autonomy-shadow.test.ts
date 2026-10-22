import { describe, expect, it } from 'vitest';
import { candidateBindingSchema, candidateEvidenceSchema, targetQueueRequestSchema, type RunSnapshot, type TargetQueueRecord } from '#domain/index.js';
import { AUTONOMY_HOLD_REASONS, TargetQueueApplication, TargetQueueDriver, autonomyRuleDigest, autonomyShadowDigest, autonomyShadowId, autonomyShadowRecord,
  autonomyShadowRecordSchema, deliverySummaryDigest, newQueueRecord, projectDeliverySummary, readSystemDeliverySummary,
  type DeliveryChangeFacts, type TargetQueueBounds, type TargetQueuePreparation, type TargetQueueStore } from '#engine/index.js';

/** OTONOM-TESLIM shadow (alpha.53 B1, law-audit folds 1-2): the queue service evaluates autonomy@1 as actor `system` once per ticket revision that
 * reaches awaiting-confirmation and records the advice outside the audit chain. The record is never an authority input. */
const identity = { scopeId: 'scope', runId: 'run', layoutRevision: 'layout', taskId: 'task', attemptId: 'attempt', generation: 1 };
function run(options: { phase?: string; workClass?: string; runId?: string } = {}): RunSnapshot {
  return { identity: { scopeId: 'scope', runId: options.runId ?? 'run', layoutRevision: 'layout' }, revision: 7,
    graph: { tasks: [{ id: 'task', kind: 'small', dependencies: [], acceptanceCriteria: ['c1'], workInput: { task: 'Fix the banner', title: 'Banner fix', acceptance: 'tests pass', scope: { paths: ['src/**'] } } }],
      criterionDefinitions: [{ id: 'c1', version: 1, description: 'exit', evaluator: { id: 'process-exit', version: 1 } }] },
    progress: [{ taskId: 'task', phase: options.phase ?? 'accepted', unresolvedEffects: false }],
    execution: { tasks: [{ taskId: 'task', profile: { id: 'profile', version: 1, parameters: {} }, acceptance: { workClass: options.workClass ?? 'small', policyRevision: 'r1', profileVersion: 1, criteria: [] } }] },
    bindings: [{ identity }] } as unknown as RunSnapshot;
}
const change: DeliveryChangeFacts = { adapter: 'workspace-patch', paths: ['src/a.ts'], added: 3, removed: 1, scope: 'in-scope', outOfScope: [] };
const ticket = { scopeId: 'scope', commandId: 'q1', revision: 4 };

describe('autonomy shadow record (pure)', () => {
  it('binds the ticket revision, the system actor, the exact rule digest and the summary digest; same input gives the same record', () => {
    const summary = projectDeliverySummary({ operation: 'deliver', identity, run: run(), target: { id: 'refs/heads/feature', protected: false }, report: null,
      model: null, verification: { runId: 'queue-verify-1', run: run({ runId: 'queue-verify-1' }) }, change });
    const record = autonomyShadowRecord(ticket, summary, 1234);
    expect(autonomyShadowRecordSchema.parse(record)).toEqual(record);
    expect(record).toEqual({ schemaVersion: 1, id: 'autonomy-shadow:q1:4', at: 1234, actor: 'system', scopeId: 'scope', commandId: 'q1', revision: 4,
      rule: { id: 'autonomy', version: 1, digest: autonomyRuleDigest() }, verdict: 'would-hold', reasons: ['model-verdict-missing'], summaryDigest: deliverySummaryDigest(summary) });
    expect(autonomyShadowRecord(ticket, summary, 1234)).toEqual(record);
    expect(autonomyShadowId('q1', 4)).toBe(record.id);
    expect(autonomyShadowDigest(record)).toMatch(/^[a-f0-9]{64}$/u);
    expect(autonomyShadowDigest({ ...record, verdict: 'would-deliver' })).not.toBe(autonomyShadowDigest(record));
    expect(deliverySummaryDigest({ ...summary, title: { source: 'untitled' } })).not.toBe(record.summaryDigest);
  });
  it('records would-deliver only when every rule condition holds', () => {
    const model = { provider: 'native-a', evidenceCapability: 'session-events', requested: { channelId: 'c', modelId: 'm', auxiliaryModelIds: [] }, init: 'm', usage: ['m'],
      verdict: 'start-name-matched', unexpected: [], evidence: 'sealed' } as never;
    const summary = projectDeliverySummary({ operation: 'deliver', identity, run: run(), target: { id: 'refs/heads/feature', protected: false }, report: null, model,
      verification: { runId: 'queue-verify-1', run: run({ runId: 'queue-verify-1' }) }, change });
    expect(autonomyShadowRecord(ticket, summary, 1)).toMatchObject({ verdict: 'would-deliver', reasons: [] });
  });
  it('refuses a malformed record (unknown reason, other actor, unbounded reasons)', () => {
    const summary = projectDeliverySummary({ operation: 'deliver', identity, run: run(), target: null, report: null, model: null, verification: null, change: null });
    const record = autonomyShadowRecord(ticket, summary, 1);
    expect(() => autonomyShadowRecordSchema.parse({ ...record, actor: 'human' })).toThrow();
    expect(() => autonomyShadowRecordSchema.parse({ ...record, reasons: ['not-a-reason'] })).toThrow();
    expect(() => autonomyShadowRecordSchema.parse({ ...record, reasons: [...AUTONOMY_HOLD_REASONS, 'target-protected'] })).toThrow();
    expect(() => autonomyShadowRecordSchema.parse({ ...record, id: 'autonomy-shadow:other:4' })).toThrow();
  });
});

describe('system delivery summary read (actor system, no principal grant)', () => {
  const ports = (runs: Record<string, RunSnapshot>) => ({ store: { async loadRun(_scope: string, runId: string) { return runs[runId] ?? null; },
    async loadBoundDispatch() { return null; }, async loadWorkerEventLog() { return null; } }, artifacts: { async read(): Promise<Uint8Array> { throw new Error('unexpected read'); } } });
  const request = { identity, operation: 'deliver' as const, target: { id: 'refs/heads/feature', protected: false }, verificationRunId: 'queue-verify-1', change };
  it('reads the Run, the verification Run and the adapter change without any authorization port', async () => {
    const summary = await readSystemDeliverySummary(request, ports({ run: run(), 'queue-verify-1': run({ runId: 'queue-verify-1' }) }));
    expect(summary).toMatchObject({ operation: 'deliver', title: { source: 'work-input', text: 'Banner fix' }, outcome: { state: 'unavailable' }, model: { state: 'unavailable' },
      tests: { verification: { state: 'available', runId: 'queue-verify-1', phase: 'accepted' } }, change: { state: 'available', files: 1 } });
  });
  it('answers null for a missing Run or an unbound Attempt, and unavailable for a missing verification Run', async () => {
    expect(await readSystemDeliverySummary(request, ports({}))).toBeNull();
    expect(await readSystemDeliverySummary({ ...request, identity: { ...identity, attemptId: 'other' } }, ports({ run: run() }))).toBeNull();
    expect((await readSystemDeliverySummary(request, ports({ run: run() })))?.tests.verification).toEqual({ state: 'unavailable' });
  });
});

const bounds: TargetQueueBounds = { capacity: 8, perTarget: 4, activeTargets: 2, batchSize: 3, batchWindowMs: 10, leaseMs: 100, verificationTimeoutMs: 1000, revalidations: 2 };
const target = { schemaVersion: 1 as const, installationId: 'i', adapter: { id: 'adapter', version: 1 }, resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'entity' } };
function verifying(n: number, operation?: 'rollback'): TargetQueueRecord {
  const request = targetQueueRequestSchema.parse({ schemaVersion: 1, commandId: 'c' + n, ...(operation ? { operation, sourceCommandId: 'source' } : {}),
    identity: { ...identity, taskId: 't' + n, attemptId: 'a' + n }, actor: { id: 'owner', issuer: 'test', subject: 'owner' },
    target, payloadDigest: 'b'.repeat(64), policyRevision: 'p1', outputDigest: 'c'.repeat(64), acceptedRevision: 1, submittedAt: 1, deadline: 1000 });
  const candidate = candidateBindingSchema.parse({ schemaVersion: 1, target, identity: request.identity, sourceBinding: 'b'.repeat(64), outputDigest: request.outputDigest,
    observedVersion: 'V0', effectiveVersion: 'V' + (n - 1), candidateVersion: 'V' + n, candidateDigest: String(n).repeat(64),
    custodyReceipt: 'e'.repeat(64), criteria: ['f'.repeat(64)], profileFingerprint: 'a'.repeat(64), replacesCommandId: null });
  return { ...newQueueRecord(request, n), revision: 2, state: 'verifying', ownerInstance: 'service', epoch: 1, candidate, effectCommandIds: ['publish-' + n] };
}
function driverFixture(records: TargetQueueRecord[], shadow?: TargetQueuePreparation['shadow']) {
  const map = new Map(records.map(r => [r.request.commandId, r]));
  const store: TargetQueueStore = { reserve() { throw new Error('not-used'); }, enqueue() { throw new Error('not-used'); }, load(_scope, id) { return map.get(id) ?? null; },
    list() { return [...map.values()]; }, epoch() { return 1; }, head() { return [...map.values()].find(r => r.state !== 'settled') ?? null; },
    change(before, after) { expect(map.get(before.request.commandId)).toEqual(before); map.set(before.request.commandId, after); return after; } };
  const app = new TargetQueueApplication(store, { async authorize() {}, async validate() {} }, bounds, () => {});
  const preparation: TargetQueuePreparation = { async prepare() { throw new Error('not-used'); }, async admitVerification() {}, effectIds: record => [`publish-${record.ordinal}`],
    async evidence(record) { const c = record.candidate!; return candidateEvidenceSchema.parse({ schemaVersion: 1, identity: c.identity, sourceBinding: c.sourceBinding,
      candidateVersion: c.candidateVersion, candidateDigest: c.candidateDigest, custodyReceipt: c.custodyReceipt, criteria: c.criteria, profileFingerprint: c.profileFingerprint,
      evidenceReceipt: 'f'.repeat(64), phase: 'accepted' }); }, ...(shadow ? { shadow } : {}) };
  return { map, driver: new TargetQueueDriver(app, bounds, preparation, 'service', () => 10) };
}

describe('queue driver shadow hook (write point: the awaiting-confirmation transition)', () => {
  it('evaluates each ticket once, on the revision that reached awaiting-confirmation; a later turn over the waiting ticket does not evaluate again', async () => {
    const seen: string[] = [], f = driverFixture([verifying(1), verifying(2)], async record => { seen.push(`${record.request.commandId}:${record.state}:${record.revision}`); });
    await f.driver.advance([...f.map.values()]);
    expect(seen).toEqual(['c1:awaiting-confirmation:3', 'c2:awaiting-confirmation:3']);
    await f.driver.advance([...f.map.values()]);
    expect(seen).toHaveLength(2);
  });
  it('a failing shadow write never blocks or alters the queue: every ticket reaches the same rows as without a shadow, the failure is kept for diagnosis', async () => {
    const plain = driverFixture([verifying(1), verifying(2)]); await plain.driver.advance([...plain.map.values()]);
    const failing = driverFixture([verifying(1), verifying(2)], async () => { throw new Error('SHADOW_DISK_FULL'); });
    await failing.driver.advance([...failing.map.values()]);
    expect(JSON.stringify([...failing.map.values()])).toBe(JSON.stringify([...plain.map.values()]));
    expect([...failing.map.values()].map(r => r.state)).toEqual(['awaiting-confirmation', 'awaiting-confirmation']);
    expect(failing.driver.shadowFailure).toMatchObject({ message: 'SHADOW_DISK_FULL' });
    expect(plain.driver.shadowFailure).toBeNull();
  });
  it('a rollback ticket is never evaluated', async () => {
    const seen: string[] = [], queued = { ...verifying(1, 'rollback'), state: 'queued' as const, candidate: null, ownerInstance: null, epoch: 0, revision: 0 };
    const f = driverFixture([queued], async record => { seen.push(record.request.commandId); });
    await f.driver.advance([...f.map.values()]);
    expect(seen).toEqual([]); expect(f.map.get('c1')?.state).toBe('queued');
  });
});
