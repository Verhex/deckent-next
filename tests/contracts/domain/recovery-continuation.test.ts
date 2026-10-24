import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { RECOVERY_POLICY_SEED, RecoveryError, assessRecoveryEffectGate, auditEventSchema, continueLostTask, freezeRecoveryPolicy, loadRecoveryPolicy, lostContinuationRefusal,
  recoveryCaseSchema, recoveryEffectGatePasses, recoveryEscalationCode, reserveRunTasks, runSnapshotSchema, effectRecordSchema, type AttemptIdentity, type EffectRecord, type RunSnapshot } from '#domain/index.js';
import { measureTaskOccupancy } from '#engine/index.js';
import type { SqliteAttemptStore } from '#adapters/index.js';
import { effectIntent, releasedLostTask } from '../support/lost-task.js';

// S6R-4 (S6R-DESIGN §7 steps 4–6, §8, §10; owner Q-R1/Q-R3/Q-R5: at most 1 automatic continuation per lost task, at most 3 Attempts per task, both
// registry data frozen at admission): the one domain transition that returns a lost task to `pending` for a NEW Attempt, and the pure effect gate
// it requires. Nothing here calls a model; S6R-5 adds the chooser.
const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const policy = freezeRecoveryPolicy(loadRecoveryPolicy(RECOVERY_POLICY_SEED), 'live', ['task']);
const timing = { now: 30, timeoutMs: 1000 };
const clear = (identity: AttemptIdentity) => assessRecoveryEffectGate(identity, [], policy);
const continuation = (identity: AttemptIdentity, overrides: Partial<Parameters<typeof continueLostTask>[3]> = {}) =>
  ({ decisionId: 'd'.repeat(64), signature: 'a'.repeat(64), gate: clear(identity), priorSignatures: [], ...overrides });
const record = (commandId: string, state: EffectRecord['state'], input: Parameters<typeof effectIntent>[1] = {}): EffectRecord => effectRecordSchema.parse({
  intent: effectIntent(commandId, input), sequence: 1, state, evidence: state === 'settled' ? { kind: 'idempotency-record', version: 'v2', observedAt: 9 } : null,
  refusal: state === 'refused' ? 'EFFECT_REJECTED' : null });
const code = (work: () => unknown) => { try { work(); } catch (error) { return error instanceof RecoveryError || (error as { code?: unknown }).code ? (error as { code: string }).code : String(error); } return 'no-error'; };

it('the registry seed holds the owner bounds (1 continuation per lost task, 3 Attempts per task) and freezes into a Run snapshot shape', () => {
  expect(loadRecoveryPolicy(RECOVERY_POLICY_SEED)).toMatchObject({ schemaVersion: 1, maxLostContinuationsPerTask: 1, maxAttemptsPerTask: 3 });
  expect(policy).toMatchObject({ schemaVersion: 1, maxLostContinuationsPerTask: 1, maxAttemptsPerTask: 3, registryRevision: expect.any(String) });
  expect(() => loadRecoveryPolicy({ ...RECOVERY_POLICY_SEED as object, maxAttemptsPerTask: 0 })).toThrow();
  expect(() => loadRecoveryPolicy({ ...RECOVERY_POLICY_SEED as object, extra: true })).toThrow();
});

it('continues a released lost task: the binding becomes `lost` with its decision id, the task pending with no custody, the next generation reservable', async () => {
  const f = await releasedLostTask(roots, stores, policy);
  const { snapshot } = continueLostTask(f.run, f.run.revision, f.identity, continuation(f.identity), timing);
  expect(snapshot.revision).toBe(f.run.revision + 1);
  expect(snapshot.bindings).toEqual([]);
  expect(snapshot.previousBindings).toEqual([{ ...f.run.bindings[0], observedKind: 'lost', recoveryDecisionId: 'd'.repeat(64) }]);
  const task = snapshot.progress[0]!;
  expect(task).toMatchObject({ taskId: 'task', phase: 'pending', unresolvedEffects: false, eligibility: { kind: 'immediate' } });
  expect(task.workerCustody).toBeUndefined();
  // The released custody of the lost Attempt never carries over: the new Attempt holds the slot again (wave occupancy skips released custody).
  const next = { ...f.identity, attemptId: 'attempt-2', generation: 2 };
  const reserved = reserveRunTasks(snapshot, snapshot.revision, [next], 31);
  expect(measureTaskOccupancy(reserved.progress)).toEqual({ execution: 1, inFlight: 1 });
  expect(() => reserveRunTasks(snapshot, snapshot.revision, [{ ...next, generation: 1 }], 31)).toThrow();
});

it('refuses typed and writes nothing when the case is not ready, the bounds are absent (Run admitted before the switch) or the Run is closing', async () => {
  const f = await releasedLostTask(roots, stores, policy), off = await releasedLostTask(roots, stores, null);
  expect(code(() => continueLostTask(off.run, off.run.revision, off.identity, continuation(off.identity), timing))).toBe('RECOVERY_OFF'); // N27
  expect(code(() => continueLostTask({ ...f.run, cancelRequested: true }, f.run.revision, f.identity, continuation(f.identity), timing))).toBe('RECOVERY_RUN_CLOSED'); // N12
  const held = { ...f.run, progress: f.run.progress.map(task => ({ ...task, workerCustody: undefined })) };
  expect(code(() => continueLostTask(held, f.run.revision, f.identity, continuation(f.identity), timing))).toBe('RECOVERY_NOT_READY'); // N8: no release, no continuation
  expect(code(() => continueLostTask(f.run, f.run.revision, { ...f.identity, attemptId: 'other' }, continuation(f.identity), timing))).toBe('RECOVERY_NOT_READY');
  expect(code(() => continueLostTask(f.run, f.run.revision - 1, f.identity, continuation(f.identity), timing))).toBe('RUN_REVISION_CONFLICT');
});

it('N1/N2: an open effect of the lost Attempt blocks the continuation; N22: a settled one without task-scoped idempotency hands it to a person', async () => {
  const f = await releasedLostTask(roots, stores, policy), producer = { kind: 'attempt' as const, identity: f.identity };
  for (const state of ['claimed', 'unknown'] as const) {
    const gate = assessRecoveryEffectGate(f.identity, [record(`c-${state}`, state, { producer })], policy);
    expect(gate.result).toBe('open'); expect(recoveryEffectGatePasses(gate)).toBe(false);
    expect(code(() => continueLostTask(f.run, f.run.revision, f.identity, continuation(f.identity, { gate }), timing))).toBe('RECOVERY_EFFECTS_OPEN');
  }
  for (const scope of [undefined, 'command'] as const) {
    const gate = assessRecoveryEffectGate(f.identity, [record('settled', 'settled', { producer, ...(scope ? { idempotencyScope: scope } : {}) })], policy);
    expect(gate).toMatchObject({ result: 'reconciled', settled: 'not-declared' });
    expect(code(() => continueLostTask(f.run, f.run.revision, f.identity, continuation(f.identity, { gate }), timing))).toBe('RECOVERY_SETTLED_NOT_IDEMPOTENT');
  }
});

it('N23: settled task-idempotent work passes as a bounded fact list; refused intents and other Attempts\' intents are outside the gate set', async () => {
  const f = await releasedLostTask(roots, stores, policy), producer = { kind: 'attempt' as const, identity: f.identity };
  const other = { kind: 'attempt' as const, identity: { ...f.identity, attemptId: 'sibling' } };
  const gate = assessRecoveryEffectGate(f.identity, [record('done', 'settled', { producer, idempotencyScope: 'task' }), record('refused', 'refused', { producer }),
    record('sibling-open', 'unknown', { producer: other }), record('direct', 'claimed', { producer: { kind: 'principal' } })], policy);
  expect(gate).toMatchObject({ result: 'reconciled', settled: 'task-idempotent' });
  expect(gate.intents.map(row => [row.commandId, row.state])).toEqual([['done', 'settled'], ['refused', 'refused']]);
  expect(gate.facts).toEqual([{ commandId: 'done', operation: { id: 'record.write', version: 1 }, target: { kind: 'record', id: 'item-done' }, version: 'v2', observedAt: 9 }]);
  expect(continueLostTask(f.run, f.run.revision, f.identity, continuation(f.identity, { gate }), timing).snapshot.progress[0]?.phase).toBe('pending');
  const many = Array.from({ length: policy.settledFacts.maxCount + 1 }, (_, n) => record(`done-${n}`, 'settled', { producer, idempotencyScope: 'task' }));
  expect(assessRecoveryEffectGate(f.identity, many, policy).settled).toBe('over-bound');
  expect(assessRecoveryEffectGate(f.identity, Array.from({ length: policy.maxGateIntents + 1 }, (_, n) => record(`r-${n}`, 'refused', { producer })), policy).result).toBe('open');
});

it('N24: a legacy intent (no producer) still open in the Run\'s scope joins the gate set fail-closed; N18: another scope\'s record is refused', async () => {
  const f = await releasedLostTask(roots, stores, policy);
  expect(assessRecoveryEffectGate(f.identity, [record('legacy', 'claimed')], policy)).toMatchObject({ result: 'open', intents: [{ commandId: 'legacy', state: 'claimed', producer: 'legacy' }] });
  expect(assessRecoveryEffectGate(f.identity, [record('legacy-done', 'settled')], policy)).toMatchObject({ result: 'clear', intents: [] });
  expect(code(() => assessRecoveryEffectGate(f.identity, [record('foreign', 'claimed', { scopeId: 'other' })], policy))).toBe('RECOVERY_INVALID');
});

/** The released snapshot with earlier superseded Attempts of the task (generation 1..n) before the lost one. */
function withHistory(run: RunSnapshot, identity: AttemptIdentity, kinds: readonly ('stalled' | 'lost')[]) {
  const previousBindings = kinds.map((kind, n) => ({ identity: { ...identity, attemptId: `old-${n}`, generation: n + 1 }, observedRevision: 1, observedKind: kind,
    ...(kind === 'stalled' ? { stallCause: 'inactivity' as const } : { recoveryDecisionId: String(n).repeat(64) }) }));
  const current = { ...run.bindings[0]!, identity: { ...identity, generation: kinds.length + 1 } };
  const snapshot = runSnapshotSchema.parse({ ...run, bindings: [current], previousBindings });
  return { snapshot, identity: current.identity };
}

it('N10/N25: past the per-task continuation bound, the total Attempt ceiling (stall + lost) or the per-Run bound, or with the same evidence signature, it escalates', async () => {
  const f = await releasedLostTask(roots, stores, policy);
  const lostOnce = withHistory(f.run, f.identity, ['lost']); // the second loss of a task already continued once (bound 1)
  expect(code(() => continueLostTask(lostOnce.snapshot, f.run.revision, lostOnce.identity, continuation(lostOnce.identity), timing))).toBe('RECOVERY_CONTINUATION_BOUND');
  const wide = { ...policy, maxLostContinuationsPerTask: 5, maxRecoveryActionsPerRun: 9 };
  const bounded = (snapshot: RunSnapshot) => runSnapshotSchema.parse({ ...snapshot, execution: { ...snapshot.execution, recovery: wide } });
  const ceiling = withHistory(f.run, f.identity, ['stalled', 'lost']); // first + stall retry + lost continuation = 3 Attempts: no 4th
  expect(code(() => continueLostTask(bounded(ceiling.snapshot), f.run.revision, ceiling.identity, continuation(ceiling.identity), timing))).toBe('RECOVERY_ATTEMPT_CEILING');
  const stalledOnce = withHistory(f.run, f.identity, ['stalled']); // first + stall retry, now lost: the 3rd Attempt is still within the ceiling
  expect(continueLostTask(stalledOnce.snapshot, f.run.revision, stalledOnce.identity, continuation(stalledOnce.identity), timing).snapshot.previousBindings).toHaveLength(2);
  expect(code(() => continueLostTask(stalledOnce.snapshot, f.run.revision, stalledOnce.identity, continuation(stalledOnce.identity, { priorSignatures: ['a'.repeat(64)] }), timing))).toBe('RECOVERY_SAME_EVIDENCE');
  const perRun = runSnapshotSchema.parse({ ...lostOnce.snapshot, execution: { ...lostOnce.snapshot.execution, recovery: { ...wide, maxRecoveryActionsPerRun: 1 } } });
  expect(code(() => continueLostTask(perRun, f.run.revision, lostOnce.identity, continuation(lostOnce.identity), timing))).toBe('RECOVERY_RUN_BOUND');
});

it('the snapshot contract: `lost` lives only on a superseded binding and always names its recovery decision', async () => {
  const f = await releasedLostTask(roots, stores, policy);
  const { snapshot } = continueLostTask(f.run, f.run.revision, f.identity, continuation(f.identity), timing);
  const lost = snapshot.previousBindings![0]!;
  expect(runSnapshotSchema.safeParse({ ...snapshot, previousBindings: [{ ...lost, recoveryDecisionId: undefined }] }).success).toBe(false);
  expect(runSnapshotSchema.safeParse({ ...snapshot, previousBindings: [{ ...lost, observedKind: 'exited' }] }).success).toBe(false);
  expect(runSnapshotSchema.safeParse({ ...f.run, bindings: [{ ...f.run.bindings[0], observedKind: 'lost', recoveryDecisionId: 'd'.repeat(64) }] }).success).toBe(false);
});

it('alpha.56 G1/G6: the would-stop shadow input passes readiness without a release and keeps every later check; only frozen low-risk tasks continue', async () => {
  const f = await releasedLostTask(roots, stores, policy), input = { signature: null, gate: clear(f.identity), priorSignatures: [] };
  const unreleased = { ...f.run, bindings: f.run.bindings.map(row => ({ ...row, observedKind: 'started' as const })), progress: f.run.progress.map(task => ({ ...task, workerCustody: undefined })) };
  expect(lostContinuationRefusal(unreleased, f.identity, input)).toBe('RECOVERY_NOT_READY');
  expect(lostContinuationRefusal(unreleased, f.identity, input, 'would-stop')).toBeNull();
  expect(lostContinuationRefusal(f.run, f.identity, input, 'would-stop')).toBe('RECOVERY_NOT_READY'); // released: not a would-stop case
  const open = assessRecoveryEffectGate(f.identity, [record('c-open', 'claimed', { producer: { kind: 'attempt', identity: f.identity } })], policy);
  expect(lostContinuationRefusal(unreleased, f.identity, { ...input, gate: open }, 'would-stop')).toBe('RECOVERY_EFFECTS_OPEN');
  expect(lostContinuationRefusal({ ...unreleased, cancelRequested: true }, f.identity, input, 'would-stop')).toBe('RECOVERY_RUN_CLOSED');
  const earlier = Object.fromEntries(Object.entries(policy).filter(([key]) => key !== 'lowRiskTaskIds')) as typeof policy; // frozen before the list: none eligible
  for (const recovery of [{ ...policy, lowRiskTaskIds: ['other'] }, earlier]) {
    expect(lostContinuationRefusal({ ...f.run, execution: { ...f.run.execution, recovery } }, f.identity, input)).toBe('RECOVERY_RISK_NOT_LOW');
    expect(lostContinuationRefusal({ ...unreleased, execution: { ...unreleased.execution, recovery } }, f.identity, input, 'would-stop')).toBe('RECOVERY_RISK_NOT_LOW');
  }
  expect(recoveryEscalationCode(new RecoveryError('RECOVERY_RISK_NOT_LOW'))).toBe('work-class-not-low-risk');
});

it('alpha.56 G1: a receipt-less termination is only a would-stop case or a would-stop shadow seal; a verdict names a choice exactly when the worker was lost', () => {
  const gate = { schemaVersion: 1, result: 'clear', complete: true, settled: 'none', intents: [], facts: [] }, d = 'a'.repeat(64);
  const kase = { schemaVersion: 1, caseId: d, revision: 1, state: 'gated', identity: { scopeId: 's', runId: 'run', taskId: 'task', attemptId: 'a', layoutRevision: 'l', generation: 1 },
    detection: { eventId: 'e', ruleId: 'container-gone', ruleVersion: 1, registryRevision: 'r', evidenceDigest: d, activity: 'missing', launcherPhase: null },
    termination: { receiptId: null, kind: 'worker-absent', exitCode: null }, gate, evidenceDigest: d, openedAtMs: 1, updatedAtMs: 1 };
  expect(recoveryCaseSchema.safeParse({ ...kase, basis: 'would-stop' }).success).toBe(true);
  expect(recoveryCaseSchema.safeParse(kase).success).toBe(false);
  expect(recoveryCaseSchema.safeParse({ ...kase, basis: 'would-stop', termination: { ...kase.termination, receiptId: 'receipt' } }).success).toBe(false);
  const seal = { kind: 'recovery-decision', caseId: d, mode: 'shadow', evidenceDigest: d, target: { runId: 'run', taskId: 'task', attemptId: 'a', generation: 1 },
    gate: { result: 'clear', settled: 'none', intents: 0 }, terminationReceiptId: null, model: null, action: 'escalate-human', causeClass: null, note: null, code: 'breaker-open',
    failure: null, standingRef: null, basis: 'would-stop' };
  const event = (subject: object) => auditEventSchema.safeParse({ schemaVersion: 1, eventId: 'e', scopeId: 's', principal: { issuer: 'i', subject: 'p' }, policyRevision: 'r', atMs: 1, subject }).success;
  expect(event(seal)).toBe(true);
  expect(event({ ...seal, mode: 'live' })).toBe(false);
  expect(event({ ...seal, basis: undefined })).toBe(false);
  const verdict = { kind: 'recovery-verdict', caseId: d, decisionEventId: `recovery-decision:shadow:${d}`, evidenceDigest: d, detection: 'lost', choice: 'escalate-human' };
  expect([event(verdict), event({ ...verdict, choice: null }), event({ ...verdict, detection: 'not-lost', choice: null })]).toEqual([true, false, true]);
});
