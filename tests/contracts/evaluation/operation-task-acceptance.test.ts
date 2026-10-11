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
async function fixture(state: EffectRecord['state'] | 'missing' = 'settled', compensable = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-operation-acceptance-')); roots.push(root); const path = join(root, 'ledger.db');
  const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
  const open = async () => { const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles); stores.push(store); return store; };
  const store = await open();
  const graph = { schemaVersion: 2 as const, revision: 1,
    tasks: [{ id: 'read', kind: 'business', dependencies: [], acceptanceCriteria: ['criterion'] }, { id: 'approve', kind: 'business', dependencies: ['read'], acceptanceCriteria: ['criterion'] }], criterionDefinitions: [definition] };
  const operationPolicy = { ...overlay, classes: overlay.classes.map(row => ({ ...row, acceptanceProfile: { ...profile,
    evidenceTypes: ['operation-settlement'], rubric: [{ criterionType: 'completion', evidenceTypes: ['operation-settlement'], weight: 1 }] } })) };
  const execution = resolveExecutionRegistry(graph, { schemaVersion: 1, revision: 'operation-registry', workClasses: operationPolicy,
    profiles: [{ id: 'fixture', version: 1, adapter: { id: 'test-supervisor', version: 1 }, parameters: {} }],
    kinds: [{ kind: 'business', profile: { id: 'fixture', version: 1 } }], evaluators: [OPERATION_EVIDENCE_EVALUATOR] },
  { profile() { return undefined; }, criterion: validateInstalledCriterion });
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  await store.createRun({ commandId: 'create', actor, identity: { scopeId: 's', runId: 'run', layoutRevision: 'layout' }, now: 0, graph, execution,
    policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['read', 'approve'] } });
  await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'run', expectedRevision: 0, now: 0, identities: [identity] });
  const claim = { owner: 'fixture', request: { protocolVersion: 1 as const, identity, workspace: root, argv: ['test-only-worker'] } };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  await mkdir(join(root, 'artifacts')); const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 65536 });
  const output = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: 'test-only dispatch output', stderr: '' })));
  await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: 'fixture', exitCode: 0, interrupted: false });
  if (state !== 'missing') {
    const claimed = await store.claimEffect(intent(compensable));
    if (state !== 'claimed') await store.saveEffect(claimed, state === 'settled' ? settleEffect(claimed, { kind: 'idempotency-record', version: '2', observedAt: 1 })
      : state === 'unknown' ? markEffectUnknown(claimed) : refuseEffect(claimed, 'EFFECT_PRECONDITION_CHANGED'));
  }
  let activeStore = store;
  const loadEffect = vi.fn((scope: string, command: string) => activeStore.loadEffect(scope, command));
  const app = (reader = store, denied = false, now = 100) => {
    activeStore = reader; return new TaskEvaluationApplication(reader, { async verify() { return principal; } },
    { async authorize() { if (denied) throw new Error('POLICY_DENIED'); } }, createInstalledTerminalEvaluator({ loadEffect, loadEffectCompensation: (scope, command) => reader.loadEffectCompensation(scope, command) }), artifacts,
    { maxEvidenceItems: 1, maxTotalBytes: 65536 }, { now: () => now, timeoutMs: 1000 }); };
  return { store, app, loadEffect, open, path, command: { schemaVersion: 1 as const, commandId: 'evaluate', identity, expectedRevision: 2 } };
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
