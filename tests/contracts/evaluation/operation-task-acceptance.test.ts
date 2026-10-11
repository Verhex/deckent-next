import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileArtifactStore, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { effectRecordSchema, settleEffect, refuseEffect, markEffectUnknown, type EffectRecord } from '#domain/index.js';
import { createInstalledTerminalEvaluator, OPERATION_EVIDENCE_EVALUATOR, validateInstalledCriterion } from '#capabilities/index.js';
import { TaskEvaluationApplication, resolveExecutionRegistry } from '#engine/index.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
import { overlay, profile } from '../domain/acceptance-fixture.js';

const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { scopeId: 's', runId: 'run', taskId: 'read', attemptId: 'attempt-read', generation: 1, layoutRevision: 'layout' };
const actor = { id: 'author', issuer: 'test', subject: 'fixture' }, principal = { ...actor, assurance: 'os-user' as const, scopeIds: ['s'] };
const definition = { id: 'criterion', version: 1, description: 'Verify durable settlement', evaluator: { id: 'operation-evidence', version: 1 }, parameters: { commandId: 'operation' } };
const intent = () => effectRecordSchema.parse({ sequence: 1, state: 'claimed', evidence: null, refusal: null, intent: { schemaVersion: 1,
  command: { schemaVersion: 1, commandId: 'operation', scopeId: 's', operation: { id: 'record.read', version: 1 },
    target: { kind: 'record', id: 'item' }, idempotencyKey: 'key', input: null, expectedVersion: null },
  descriptor: { schemaVersion: 1, operation: { id: 'record.read', version: 1 }, targetKind: 'record', effectClass: 'read', approval: 'policy', precondition: 'none', compensation: null, inputMaxBytes: 1024 },
  actor, inputDigest: 'a'.repeat(64), idempotencyKeyHash: 'b'.repeat(64) } }).intent;
/** Real application + ledger with test-only dispatch/target records. No external target or worker execution is claimed. */
async function fixture(state: EffectRecord['state'] | 'missing' = 'settled') {
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
    const claimed = await store.claimEffect(intent());
    if (state !== 'claimed') await store.saveEffect(claimed, state === 'settled' ? settleEffect(claimed, { kind: 'idempotency-record', version: '2', observedAt: 1 })
      : state === 'unknown' ? markEffectUnknown(claimed) : refuseEffect(claimed, 'EFFECT_PRECONDITION_CHANGED'));
  }
  const loadEffect = vi.fn((scope: string, command: string) => store.loadEffect(scope, command));
  const app = (reader = store, denied = false) => new TaskEvaluationApplication(reader, { async verify() { return principal; } },
    { async authorize() { if (denied) throw new Error('POLICY_DENIED'); } }, createInstalledTerminalEvaluator({ loadEffect }), artifacts,
    { maxEvidenceItems: 1, maxTotalBytes: 65536 }, { now: () => 100, timeoutMs: 1000 });
  return { store, app, loadEffect, open, command: { schemaVersion: 1 as const, commandId: 'evaluate', identity, expectedRevision: 2 } };
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
      } else expect(evaluation.criteria[0].verdict).toBe(state === 'refused' ? 'fail' : 'unknown');
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
});
