import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileArtifactStore, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { effectRecordSchema, settleEffect, refuseEffect, markEffectUnknown, type EffectRecord } from '#domain/index.js';
import { createInstalledTerminalEvaluator, OPERATION_EVIDENCE_EVALUATOR, validateInstalledCriterion } from '#capabilities/index.js';
import { TaskEvaluationApplication, resolveExecutionRegistry, describeTaskEvaluationReceipt, projectRunView, selectRunAcceptanceEvaluations } from '#engine/index.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
import { overlay, profile } from '../domain/acceptance-fixture.js';

const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { scopeId: 's', runId: 'run', taskId: 'read', attemptId: 'attempt-read', generation: 1, layoutRevision: 'layout' };
const actor = { id: 'author', issuer: 'test', subject: 'fixture' }, principal = { ...actor, assurance: 'os-user' as const, scopeIds: ['s'] };
const definition = { id: 'criterion', version: 1, description: 'Verify durable settlement', evaluator: { id: 'operation-evidence', version: 1 }, parameters: { commandId: 'operation' } };
const intent = (compensable = false) => effectRecordSchema.parse({ sequence: 1, state: 'claimed', evidence: null, refusal: null, intent: { schemaVersion: 1,
  command: { schemaVersion: 1, commandId: 'operation', scopeId: 's', operation: { id: 'record.read', version: 1 },
    target: { kind: 'record', id: 'item' }, idempotencyKey: 'key', input: null, expectedVersion: null },
  descriptor: { schemaVersion: 1, operation: { id: 'record.read', version: 1 }, targetKind: 'record', effectClass: compensable ? 'write' : 'read', approval: 'policy', precondition: 'none', compensation: compensable ? { id: 'record.undo', version: 1 } : null, inputMaxBytes: 1024 },
  actor, inputDigest: 'a'.repeat(64), idempotencyKeyHash: 'b'.repeat(64) } }).intent;
/** Real application + ledger with test-only dispatch/target records. No external target or worker execution is claimed. */
async function fixture(state: EffectRecord['state'] | 'missing' = 'settled', compensable = false,
  binding: { startedAt?: number; observedAt?: number; effectActor?: typeof actor; capacity?: number; extraCriterion?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-operation-acceptance-')); roots.push(root); const path = join(root, 'ledger.db');
  const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
  const open = async () => { const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles); stores.push(store); return store; };
  const store = await open();
  const graph = { schemaVersion: 2 as const, revision: 1,
    tasks: [{ id: 'read', kind: 'business', dependencies: [], acceptanceCriteria: binding.extraCriterion ? ['criterion', 'other-criterion'] : ['criterion'] }, { id: 'approve', kind: 'business', dependencies: ['read'], acceptanceCriteria: ['criterion'] }], criterionDefinitions: [definition, ...(binding.extraCriterion ? [{ ...definition, id: 'other-criterion', parameters: { commandId: 'missing-other-operation' } }] : [])] };
  const operationPolicy = { ...overlay, classes: overlay.classes.map(row => ({ ...row, acceptanceProfile: { ...profile,
    evidenceTypes: ['operation-settlement'], rubric: [{ criterionType: 'completion', evidenceTypes: ['operation-settlement'], weight: 1 }] } })) };
  const execution = resolveExecutionRegistry(graph, { schemaVersion: 1, revision: 'operation-registry', workClasses: operationPolicy,
    profiles: [{ id: 'fixture', version: 1, adapter: { id: 'test-supervisor', version: 1 }, parameters: {} }],
    kinds: [{ kind: 'business', profile: { id: 'fixture', version: 1 } }], evaluators: [OPERATION_EVIDENCE_EVALUATOR] },
  { profile() { return undefined; }, criterion: validateInstalledCriterion });
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: binding.capacity ?? 1, inFlightSlots: binding.capacity ?? 1 } });
  await store.createRun({ commandId: 'create', actor, identity: { scopeId: 's', runId: 'run', layoutRevision: 'layout' }, now: 0, graph, execution,
    policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['read', 'approve'] } });
  await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'run', expectedRevision: 0, now: 0, identities: [identity] });
  const claim = { owner: 'fixture', request: { protocolVersion: 1 as const, identity, workspace: root, argv: ['test-only-worker'] } };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim, binding.startedAt ?? 1);
  await mkdir(join(root, 'artifacts')); const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 65536 });
  const output = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: 'test-only dispatch output', stderr: '' })));
  await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: 'fixture', exitCode: 0, interrupted: false });
  if (state !== 'missing') {
    const claimed = await store.claimEffect({ ...intent(compensable), actor: binding.effectActor ?? actor });
    if (state !== 'claimed') await store.saveEffect(claimed, state === 'settled' ? settleEffect(claimed, { kind: 'idempotency-record', version: '2', observedAt: binding.observedAt ?? 1 })
      : state === 'unknown' ? markEffectUnknown(claimed) : refuseEffect(claimed, 'EFFECT_PRECONDITION_CHANGED'));
  }
  let activeStore = store;
  const loadEffect = vi.fn((scope: string, command: string) => activeStore.loadEffect(scope, command));
  const app = (reader = store, denied = false, now = 100) => {
    activeStore = reader; return new TaskEvaluationApplication(reader, { async verify() { return principal; } },
    { async authorize() { if (denied) throw new Error('POLICY_DENIED'); } }, createInstalledTerminalEvaluator({ loadEffect, loadEffectCompensation: (scope, command) => reader.loadEffectCompensation(scope, command) }), artifacts,
    { maxEvidenceItems: 1, maxTotalBytes: 65536 }, { now: () => now, timeoutMs: 1000 }); };
  return { store, app, loadEffect, open, path, root, artifacts, graph, execution, command: { schemaVersion: 1 as const, commandId: 'evaluate', identity, expectedRevision: 2 } };
}
async function addCompensation(store: SqliteAttemptStore, state: EffectRecord['state'], commandId = 'undo', scopeId = 's') {
  const original = intent(true);
  const claimed = await store.claimEffect({ ...original, command: { ...original.command, commandId, scopeId,
    operation: { id: 'record.undo', version: 1 }, idempotencyKey: commandId, compensates: 'operation' },
    descriptor: { ...original.descriptor, operation: { id: 'record.undo', version: 1 }, compensation: null },
    idempotencyKeyHash: createHash('sha256').update(scopeId + commandId).digest('hex') });
  return state === 'claimed' ? claimed : store.saveEffect(claimed, state === 'settled'
    ? settleEffect(claimed, { kind: 'idempotency-record', version: '3', observedAt: 2 })
    : state === 'unknown' ? markEffectUnknown(claimed) : refuseEffect(claimed, 'EFFECT_REJECTED'));
}
describe.skipIf(process.platform === 'win32')('POSIX retained-output operation acceptance', () => {
  it.each([['OPERATION_EVIDENCE_EARLIER', { startedAt: 2 }],
    ['OPERATION_EVIDENCE_PRINCIPAL', { effectActor: { ...actor, issuer: 'foreign' } }]] as const)(
    'retains %s on inspect after rejecting borrowed evidence and reopen', async (reason, binding) => {
      const f = await fixture('settled', false, binding), receipt = await f.app().execute(f.command);
      expect(receipt.snapshot.progress[0]!.phase).toBe('failed');
      expect(describeTaskEvaluationReceipt(receipt).run.tasks[0]!.acceptance!.results![0]).toMatchObject({ verdict: 'fail', reason });
      f.store.close(); stores.splice(stores.indexOf(f.store), 1);
      const reopened = await f.open(), stored = (await reopened.loadRunReceipt('s', 'evaluate'))!;
      expect(stored).toEqual(receipt);
      expect(projectRunView(stored.snapshot, [], selectRunAcceptanceEvaluations(stored.snapshot, [stored])).tasks[0]!.acceptance!.results![0]!.reason).toBe(reason);
    });
  it('allows the durable executing principal as well as the Run author', async () => {
    const f = await fixture('settled', false, { effectActor: { ...actor, id: 'test-launcher' } });
    expect((await f.app().execute(f.command)).snapshot.progress[0]!.phase).toBe('accepted');
  });
  it.each([false, true])('refuses reuse by a second Task with replay and reopen (legacy-shaped receipt %s)', async legacy => {
    const f = await fixture(); let first = await f.app().execute(f.command);
    if (legacy) {
      const payload = JSON.parse(first.command); delete payload.evaluation.criteria[0].effectEvidence;
      first = { ...first, command: JSON.stringify(payload) };
      const db = new DatabaseSync(f.path);
      try { db.prepare('UPDATE run_receipts SET command=? WHERE scope_id=? AND command_id=?').run(first.command, 's', 'evaluate'); } finally { db.close(); }
    }
    const next = { ...identity, taskId: 'approve', attemptId: 'attempt-approve' };
    await f.store.reserveRunTasks({ commandId: 'reserve-second', actor, scopeId: 's', runId: 'run', expectedRevision: 3, now: 1, identities: [next] });
    const claim = { owner: 'fixture', request: { protocolVersion: 1 as const, identity: next, workspace: f.root, argv: ['test-only-worker'] } };
    await f.store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(f.store, claim);
    const output = await f.artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity: next, completeness: 'complete', stdout: 'test-only dispatch output', stderr: '' })));
    await f.store.retainDispatchOutput(claim, output); await f.store.finishDispatch(claim, { handle: 'fixture', exitCode: 0, interrupted: false });
    const command = { ...f.command, identity: next, commandId: 'evaluate-second', expectedRevision: 5 };
    const second = await f.app().execute(command);
    expect(second.snapshot.progress[0]!.phase).toBe('accepted'); expect(second.snapshot.progress[1]!.phase).toBe('failed');
    expect(describeTaskEvaluationReceipt(second).run.tasks[1]!.acceptance!.results![0]).toMatchObject({ verdict: 'fail', reason: 'OPERATION_EVIDENCE_REUSED' });
    const recorded = JSON.parse(second.command); delete recorded.action;
    expect(await f.store.commitTaskEvaluation(recorded)).toEqual(second);
    expect(await f.app().execute(command)).toEqual(second); expect(await f.app().execute(f.command)).toEqual(first);
    f.store.close(); stores.splice(stores.indexOf(f.store), 1); const reopened = await f.open();
    expect(await reopened.loadRunReceipt('s', 'evaluate-second')).toEqual(second);
  });
  it('counts an audited human acceptance and refuses a later human reuse before audit or mutation', async () => {
    const f = await fixture('settled', false, { capacity: 2, extraCriterion: true }), other = await f.open();
    const next = { ...identity, runId: 'other-run', attemptId: 'other-attempt' };
    await other.createRun({ commandId: 'create-other', actor, identity: { scopeId: 's', runId: next.runId, layoutRevision: 'layout' }, now: 0,
      graph: f.graph, execution: f.execution, policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['read', 'approve'] } });
    await other.reserveRunTasks({ commandId: 'reserve-other', actor, scopeId: 's', runId: next.runId, expectedRevision: 0, now: 0, identities: [next] });
    const claim = { owner: 'fixture', request: { protocolVersion: 1 as const, identity: next, workspace: f.root, argv: ['test-only-worker'] } };
    await other.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(other, claim);
    const output = await f.artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity: next, completeness: 'complete', stdout: 'test-only dispatch output', stderr: '' })));
    await other.retainDispatchOutput(claim, output); await other.finishDispatch(claim, { handle: 'fixture', exitCode: 0, interrupted: false });
    const first = await f.app().execute(f.command);
    const second = await f.app(other).execute({ ...f.command, identity: next, commandId: 'evaluate-other' });
    expect(first.snapshot.progress[0]!.phase).toBe('awaiting-decision'); expect(second.snapshot.progress[0]!.phase).toBe('awaiting-decision');
    const { AuditApplication } = await import('#engine/index.js'), { createHmacIntegrity } = await import('#platform/index.js');
    const integrity = createHmacIntegrity('audit', new Uint8Array(32).fill(1));
    const write = { schemaVersion: 1 as const, scopeId: 's', runId: 'run', taskId: 'read', commandId: 'human-accept', action: 'accept' as const,
      expectedRevision: 3, now: 200, timeoutMs: 1000, actor: { ...actor, assurance: 'os-user' as const } };
    const accepted = await f.store.commitRunLifecycle(write, (store, snapshot) => {
      new AuditApplication(store, integrity).record({ schemaVersion: 1, eventId: 'human-decision', scopeId: 's', principal: { issuer: actor.issuer, subject: actor.subject },
        policyRevision: 'policy', atMs: 200, subject: { kind: 'run-lifecycle', action: 'accept', runId: 'run', commandId: write.commandId,
          taskId: 'read', revision: snapshot.revision, evidence: 'model-unverified' } });
    });
    expect(accepted.snapshot.progress[0]!.phase).toBe('accepted');
    const audit = vi.fn();
    await expect(other.commitRunLifecycle({ ...write, runId: next.runId, commandId: 'human-reuse' }, audit)).rejects.toMatchObject({ code: 'OPERATION_EVIDENCE_REUSED' });
    expect(audit).not.toHaveBeenCalled(); expect(await other.loadRunReceipt('s', 'human-reuse')).toBeNull();
    expect((await other.loadRun('s', next.runId))!.revision).toBe(3);
  });
  it('serializes two independent Runs citing one operation after both evaluated it as legitimate', async () => {
    const f = await fixture('settled', false, { capacity: 2 }), other = await f.open();
    const next = { ...identity, runId: 'other-run', attemptId: 'other-attempt' };
    await other.createRun({ commandId: 'create-other', actor, identity: { scopeId: 's', runId: next.runId, layoutRevision: 'layout' }, now: 0,
      graph: f.graph, execution: f.execution, policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['read', 'approve'] } });
    await other.reserveRunTasks({ commandId: 'reserve-other', actor, scopeId: 's', runId: next.runId, expectedRevision: 0, now: 0, identities: [next] });
    const claim = { owner: 'fixture', request: { protocolVersion: 1 as const, identity: next, workspace: f.root, argv: ['test-only-worker'] } };
    await other.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(other, claim);
    const output = await f.artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity: next, completeness: 'complete', stdout: 'test-only dispatch output', stderr: '' })));
    await other.retainDispatchOutput(claim, output); await other.finishDispatch(claim, { handle: 'fixture', exitCode: 0, interrupted: false });
    let arrivals = 0, release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    for (const store of [f.store, other]) {
      const commit = store.commitTaskEvaluation.bind(store);
      vi.spyOn(store, 'commitTaskEvaluation').mockImplementationOnce(async input => {
        expect(input.evaluation.criteria[0]!.verdict).toBe('pass');
        if (++arrivals === 2) release(); await ready; return commit(input);
      });
    }
    const receipts = await Promise.all([f.app().execute(f.command), f.app(other).execute({ ...f.command, identity: next, commandId: 'evaluate-other' })]);
    expect(receipts.map(row => row.snapshot.progress[0]!.phase).sort()).toEqual(['accepted', 'failed']);
    const refused = receipts.find(row => row.snapshot.progress[0]!.phase === 'failed')!;
    expect(JSON.parse(refused.command).evaluation.criteria[0].reason).toBe('OPERATION_EVIDENCE_REUSED');
    expect(describeTaskEvaluationReceipt(refused).run.tasks[0]!.acceptance!.score).toBe(0);
    const reopened = await f.open();
    for (const receipt of receipts) expect(await reopened.loadRunReceipt('s', receipt.commandId)).toEqual(receipt);
  });
  it.each([{ startedAt: 2 }, { effectActor: { ...actor, subject: 'foreign' } }])(
    'rechecks temporal and authority binding against a forged passing commit (%#)', async binding => {
      const f = await fixture('settled', false, binding), commit = f.store.commitTaskEvaluation.bind(f.store);
      vi.spyOn(f.store, 'commitTaskEvaluation').mockImplementationOnce(async input => {
        const row = input.evaluation.criteria[0]!;
        const criterion = { ...row }; delete criterion.reason;
        return commit({ ...input, evaluation: { ...input.evaluation, criteria: [{ ...criterion, verdict: 'pass', evidenceTypes: ['operation-settlement'],
          evidenceReferences: [{ id: 'operation', digest: row.effectEvidence!.digest! }] }],
          acceptance: { ...input.evaluation.acceptance!, score: 1, ceilingReasons: [] } } });
      });
      await expect(f.app().execute(f.command)).rejects.toThrow('TASK_EVALUATION_STALE');
      expect(await f.store.loadRunReceipt('s', 'evaluate')).toBeNull(); expect((await f.store.loadRun('s', 'run'))!.revision).toBe(2);
    });
});
describe.skipIf(process.platform === 'win32')('POSIX retained-output operation state and recovery', () => {
  it.each([['settled', 'accepted'], ['unknown', 'awaiting-decision'], ['claimed', 'awaiting-decision'], ['missing', 'awaiting-decision'], ['refused', 'failed']] as const)(
    'maps durable %s to %s despite the same exit0 and retains canonical criterion evidence', async (state, phase) => {
      const f = await fixture(state), receipt = await f.app().execute(f.command);
      expect(receipt.snapshot.progress[0]!.phase).toBe(phase);
      expect(receipt.snapshot.progress[1]!.phase).toBe(state === 'refused' ? 'skipped' : 'pending'); expect(receipt.snapshot.bindings).toHaveLength(1);
      const evaluation = JSON.parse(receipt.command).evaluation;
      expect(evaluation.identity).toEqual(identity);
      if (state === 'settled') {
        const effect = (await f.store.loadEffect('s', 'operation'))!;
        expect(evaluation.criteria[0]).toMatchObject({ verdict: 'pass', evidenceTypes: ['operation-settlement'],
          evidenceReferences: [{ id: 'operation', digest: createHash('sha256').update(JSON.stringify(effect)).digest('hex') }] });
        expect(evaluation.acceptance.score).toBe(1);
      } else {
        expect(evaluation.criteria[0]).toMatchObject({ verdict: state === 'refused' ? 'fail' : 'unknown',
          reason: state === 'refused' ? 'EFFECT_PRECONDITION_CHANGED' : state === 'missing' ? 'OPERATION_EVIDENCE_MISSING' : 'OPERATION_EVIDENCE_UNSETTLED' });
        expect(evaluation.criteria[0].evidenceTypes).toEqual([]);
      }
      expect(describeTaskEvaluationReceipt(receipt).run.tasks[0]!.acceptance!.results).toEqual(evaluation.criteria);
      expect(await f.app().execute(f.command)).toEqual(receipt); expect(f.loadEffect).toHaveBeenCalledTimes(1);
      f.store.close(); stores.splice(stores.indexOf(f.store), 1);
      const reopened = await f.open(); expect(await reopened.loadRunReceipt('s', 'evaluate')).toEqual(receipt);
      expect((await reopened.loadRun('s', 'run'))!.progress).toEqual(receipt.snapshot.progress);
    });
  it('refuses denied and stale evaluations before reading any operation evidence', async () => {
    const f = await fixture(); await expect(f.app(f.store, true).execute(f.command)).rejects.toThrow('POLICY_DENIED');
    await expect(f.app().execute({ ...f.command, expectedRevision: 1 })).rejects.toThrow('TASK_EVALUATION_STALE');
    await expect(f.app().execute({ ...f.command, identity: { ...identity, generation: 2 } })).rejects.toThrow();
    expect(f.loadEffect).not.toHaveBeenCalled(); expect(await f.store.loadRunReceipt('s', 'evaluate')).toBeNull();
  });
  it.each([['settled', 'failed', 'OPERATION_EVIDENCE_COMPENSATED'], ['claimed', 'awaiting-decision', 'OPERATION_COMPENSATION_UNSETTLED'],
    ['unknown', 'awaiting-decision', 'OPERATION_COMPENSATION_UNSETTLED'], ['refused', 'accepted', undefined]] as const)(
    'reads canonical %s compensation without mutating the original, including reopen', async (state, phase, reason) => {
      const f = await fixture('settled', true), original = await f.store.loadEffect('s', 'operation');
      const undo = await addCompensation(f.store, state), receipt = await f.app().execute(f.command);
      expect(receipt.snapshot.progress[0]!.phase).toBe(phase);
      const evaluation = JSON.parse(receipt.command).evaluation;
      expect(evaluation.criteria[0].reason).toBe(reason);
      expect(await f.store.loadEffect('s', 'operation')).toEqual(original);
      expect(evaluation.criteria[0].effectEvidence.compensation).toEqual(state === 'refused' ? null : {
        commandId: 'undo', digest: createHash('sha256').update(JSON.stringify(undo)).digest('hex') });
      f.store.close(); stores.splice(stores.indexOf(f.store), 1); const reopened = await f.open();
      const loaded = (await reopened.loadRunReceipt('s', 'evaluate'))!;
      expect(loaded).toEqual(receipt); expect(await reopened.loadEffectCompensation('s', 'operation')).toEqual(state === 'refused' ? null : undo);
      const run = (await reopened.loadRun('s', 'run'))!;
      const evaluations = selectRunAcceptanceEvaluations(run, [{ commandId: loaded.commandId, command: loaded.command }]);
      expect(projectRunView(run, [], evaluations).tasks[0]!.acceptance!.results).toEqual(evaluation.criteria);
    });
  it('a later refused compensation cannot hide a settled one; foreign scope and unrelated original are excluded', async () => {
    const f = await fixture('settled', true);
    await addCompensation(f.store, 'settled', 'foreign', 'other');
    expect(await f.store.loadEffectCompensation('s', 'operation')).toBeNull();
    expect(await f.store.loadEffectCompensation('s', 'unrelated')).toBeNull();
    const settled = await addCompensation(f.store, 'settled'); await addCompensation(f.store, 'refused', 'later-refused');
    expect(await f.store.loadEffectCompensation('s', 'operation')).toEqual(settled);
    expect((await f.app().execute(f.command)).snapshot.progress[0]!.phase).toBe('failed');
  });
  it('unknown evidence holds; reconcile opens one same-Attempt evaluation after reopen, with immutable replay', async () => {
    const f = await fixture('unknown'), held = await f.app().execute(f.command);
    const attempt = await f.store.load('s', identity.attemptId), dispatch = await f.store.loadBoundDispatch(identity);
    const retry = { ...f.command, commandId: 'reconcile-evaluation', expectedRevision: 3 };
    await expect(f.app().execute(retry)).rejects.toThrow('TASK_EVALUATION_NOT_READY');
    expect(await f.store.loadRunReceipt('s', retry.commandId)).toBeNull();
    const uncertain = (await f.store.loadEffect('s', 'operation'))!;
    await f.store.saveEffect(uncertain, settleEffect(uncertain, { kind: 'idempotency-record', version: '2', observedAt: 2 }));
    f.store.close(); stores.splice(stores.indexOf(f.store), 1); const reopened = await f.open();
    const returned = await f.app(reopened, false, 200).execute(retry), evaluation = JSON.parse(returned.command).evaluation;
    expect(returned.snapshot.progress[0]!.phase).toBe('accepted'); expect(returned.snapshot.bindings).toEqual(held.snapshot.bindings);
    expect(evaluation.identity).toEqual(identity); expect(evaluation.returnEvidence.kind).toBe('criterion-evidence');
    expect(evaluation.evidenceDigests).toContain(evaluation.returnEvidence.digest);
    expect(await reopened.load('s', identity.attemptId)).toEqual(attempt); expect(await reopened.loadBoundDispatch(identity)).toEqual(dispatch);
    expect(await f.app(reopened).execute(retry)).toEqual(returned);
    expect(await f.app(reopened).execute(f.command)).toEqual(held);
    f.loadEffect.mockClear();
    await expect(f.app(reopened).execute({ ...retry, commandId: 'new-evaluation', expectedRevision: 4 })).rejects.toThrow('TASK_EVALUATION_NOT_READY');
    expect(f.loadEffect).not.toHaveBeenCalled();
  });
  it.each(['missing', 'claimed'] as const)('consumes each new %s → unknown state once while keeping the original deadline', async state => {
    const f = await fixture(state), held = await f.app().execute(f.command);
    const claimed = state === 'missing' ? await f.store.claimEffect(intent()) : (await f.store.loadEffect('s', 'operation'))!;
    await f.store.saveEffect(claimed, markEffectUnknown(claimed));
    const returned = await f.app(f.store, false, 200).execute({ ...f.command, commandId: 'new-state', expectedRevision: 3 });
    expect(returned.snapshot.progress[0]!.decision).toMatchObject({ since: 100, deadline: 1100 });
    expect(held.snapshot.progress[0]!.decision!.deadline).toBe(1100);
    await expect(f.app().execute({ ...f.command, commandId: 'same-state', expectedRevision: 4 })).rejects.toThrow('TASK_EVALUATION_NOT_READY');
    expect((await f.store.loadRun('s', 'run'))!.revision).toBe(4);
  });
  it('an open compensation holds until refusal evidence opens one return to original acceptance', async () => {
    const f = await fixture('settled', true), undo = await addCompensation(f.store, 'claimed');
    const held = await f.app().execute(f.command);
    expect(held.snapshot.progress[0]!.phase).toBe('awaiting-decision');
    await f.store.saveEffect(undo, refuseEffect(undo, 'EFFECT_REJECTED'));
    const returned = await f.app().execute({ ...f.command, commandId: 'refused-compensation', expectedRevision: 3 });
    expect(returned.snapshot.progress[0]!.phase).toBe('accepted');
    expect(JSON.parse(returned.command).evaluation.returnEvidence.kind).toBe('criterion-evidence');
  });
  it('expired and cancelled returns stop before the criterion reader even when reconciliation settled', async () => {
    const f = await fixture('unknown'), held = await f.app().execute(f.command);
    const uncertain = (await f.store.loadEffect('s', 'operation'))!;
    await f.store.saveEffect(uncertain, settleEffect(uncertain, { kind: 'idempotency-record', version: '2', observedAt: 2 }));
    f.loadEffect.mockClear();
    await expect(f.app(f.store, false, 1100).execute({ ...f.command, commandId: 'expired', expectedRevision: 3 })).rejects.toThrow('TASK_EVALUATION_NOT_READY');
    const load = vi.spyOn(f.store, 'loadRun').mockResolvedValue({ ...held.snapshot, cancelRequested: true });
    await expect(f.app().execute({ ...f.command, commandId: 'cancelled', expectedRevision: 3 })).rejects.toThrow('TASK_EVALUATION_NOT_READY');
    load.mockRestore(); expect(f.loadEffect).not.toHaveBeenCalled(); expect(await f.store.loadRun('s', 'run')).toEqual(held.snapshot);
  });
  it.each(['settlement', 'compensation'] as const)('rejects a %s change between reader and commit in the same durable transaction', async change => {
    const f = await fixture(change === 'settlement' ? 'unknown' : 'settled', change === 'compensation');
    const before = await f.store.loadRun('s', 'run'), commit = f.store.commitTaskEvaluation.bind(f.store);
    vi.spyOn(f.store, 'commitTaskEvaluation').mockImplementationOnce(async input => {
      if (change === 'compensation') await addCompensation(f.store, 'settled');
      else { const record = (await f.store.loadEffect('s', 'operation'))!;
        await f.store.saveEffect(record, settleEffect(record, { kind: 'idempotency-record', version: '2', observedAt: 2 })); }
      return commit(input);
    });
    await expect(f.app().execute(f.command)).rejects.toThrow('TASK_EVALUATION_STALE');
    expect(await f.store.loadRun('s', 'run')).toEqual(before); expect(await f.store.loadRunReceipt('s', 'evaluate')).toBeNull();
  });
  it.each(['digest', 'commandId'] as const)('rejects a forged criterion-state %s before writing acceptance', async field => {
    const f = await fixture('unknown'), held = await f.app().execute(f.command);
    const input = JSON.parse(held.command); delete input.action;
    input.commandId = 'forged'; input.evaluation.evaluationId = 'forged'; input.expectedRevision = 3;
    input.evaluation.criteria[0].effectEvidence[field] = field === 'digest' ? 'f'.repeat(64) : 'foreign';
    await expect(f.store.commitTaskEvaluation(input)).rejects.toThrow('TASK_EVALUATION_STALE');
    expect(await f.store.loadRunReceipt('s', 'forged')).toBeNull();
  });
  it('malformed canonical compensation is refused rather than producing acceptance', async () => {
    const f = await fixture('settled', true); await addCompensation(f.store, 'settled');
    const db = new DatabaseSync(f.path);
    try { db.prepare("UPDATE effect_intents SET record='{}' WHERE command_id='undo'").run(); } finally { db.close(); }
    await expect(f.app().execute(f.command)).rejects.toThrow('EFFECT_CORRUPT');
    expect(await f.store.loadRunReceipt('s', 'evaluate')).toBeNull();
  });

});
