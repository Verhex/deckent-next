import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { TaskEvaluationApplication } from '#engine/core/task-evaluation/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
const request = { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['task'] };
const command = { schemaVersion: 1 as const, commandId: 'evaluate-1', identity, expectedRevision: 2 };
const principal = { id: 'evaluator-user', issuer: 'test', subject: 'subject', assurance: 'os-user' as const, scopeIds: ['s'] };

async function fixture(output: 'complete' | 'partial' | 'malformed' = 'complete') {
  const root = await mkdtemp(join(tmpdir(), 'deckent-evaluation-app-')); roots.push(root);
  const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const };
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), options, 'allow', custodyProfiles); stores.push(store);
  await admitRunAttempts(store, [identity]); await mkdir(join(root, 'artifacts'), { mode: 0o700 });
  const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 4096 });
  const bytes = output === 'malformed' ? Buffer.from('{not-json') : Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: output, stdout: 'ok', stderr: '' }));
  const receipt = await artifacts.put('s', bytes); const claim = { request, owner: 'supervisor' };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  await store.retainDispatchOutput(claim, receipt); await store.finishDispatch(claim, { handle: 'h', exitCode: 0, interrupted: false });
  const state = { allow: true, reads: 0, evaluations: 0, lastEvaluation: null as { evaluator: unknown; criterion: unknown; terminal: unknown } | null };
  const verifier = { async verify() { return principal; } };
  const authorization = { async authorize() { if (!state.allow) throw new Error('POLICY_DENIED'); } };
  const evaluator = { async evaluate(evaluator: unknown, criterion: unknown, terminal: unknown) {
    state.evaluations++; state.lastEvaluation = { evaluator, criterion, terminal }; return 'pass' as const;
  } };
  const app = new TaskEvaluationApplication(store, verifier, authorization, evaluator, artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 });
  return { app, store, artifacts, state, authorization, evaluator };
}

it('rejects caller verdict, evaluator, actor and path fields before ledger reads', async () => {
  const f = await fixture();
  const guarded = new Proxy(f.store, { get(target, property, receiver) {
    if (property === 'loadRunReceipt' || property === 'loadRun' || property === 'load' || property === 'loadBoundDispatch') {
      const method = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => { f.state.reads++; return method.apply(target, args); };
    }
    return Reflect.get(target, property, receiver);
  } });
  const denied = new TaskEvaluationApplication(guarded, { async verify() { return principal; } }, f.authorization, f.evaluator, f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 });
  for (const extra of [{ verdict: 'pass' }, { evaluator: 'process-exit' }, { actor: principal }, { path: '/tmp/output' }]) {
    await expect(denied.execute({ ...command, ...extra })).rejects.toThrow();
  }
  f.state.allow = false;
  await expect(denied.execute(command)).rejects.toThrow('POLICY_DENIED');
  expect(f.state.reads).toBe(0); expect(f.state.evaluations).toBe(0);
});

it.each(['partial', 'malformed'] as const)('rejects %s retained evidence without invoking the evaluator', async output => {
  const f = await fixture(output);
  await expect(f.app.execute(command)).rejects.toThrow('TASK_EVIDENCE_UNLINKED'); expect(f.state.evaluations).toBe(0);
});

it('derives the pinned criterion, commits once, and replays without reevaluation', async () => {
  const f = await fixture(); const first = await f.app.execute(command);
  expect(first.snapshot.progress[0]).toMatchObject({ phase: 'accepted', unresolvedEffects: false });
  expect(f.state.lastEvaluation).toMatchObject({
    evaluator: { id: 'test-evaluator', version: 1, implementation: { id: 'test-evaluator', version: 1 } },
    criterion: { id: 'verified', evaluator: { id: 'test-evaluator', version: 1 } },
    terminal: { exitCode: 0, interrupted: false },
  });
  expect(f.state.evaluations).toBe(1);
  expect(await f.app.execute(command)).toEqual(first); expect(f.state.evaluations).toBe(1);
  f.state.allow = false;
  await expect(f.app.execute(command)).rejects.toThrow('POLICY_DENIED'); expect(f.state.evaluations).toBe(1);
});

it('leaves the Run unchanged when authorization is revoked after evaluation', async () => {
  const f = await fixture(); const before = await f.store.loadRun('s', 'r');
  let calls = 0;
  const revoked = new TaskEvaluationApplication(f.store, { async verify() { return principal; } }, {
    async authorize() { if (++calls === 2) throw new Error('POLICY_DENIED'); },
  }, { async evaluate() { calls = 1; return 'pass' as const; } }, f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 });
  await expect(revoked.execute(command)).rejects.toThrow('POLICY_DENIED');
  expect(await f.store.loadRun('s', 'r')).toEqual(before);
});

it('rejects stale Run and Attempt identities before evaluator execution', async () => {
  const f = await fixture();
  await expect(f.app.execute({ ...command, expectedRevision: 1 })).rejects.toThrow('TASK_EVALUATION_STALE');
  await expect(f.app.execute({ ...command, identity: { ...identity, generation: 2 } })).rejects.toThrow();
  expect(f.state.evaluations).toBe(0);
});

it('rejects a corrupt replay snapshot without reevaluating', async () => {
  const f = await fixture(); const original = await f.app.execute(command);
  const receipt = await f.store.loadRunReceipt('s', command.commandId);
  expect(receipt).toBeTruthy();
  const corrupt = { ...receipt!, snapshot: { ...receipt!.snapshot, revision: original.snapshot.revision + 1 } };
  const replayStore = new Proxy(f.store, { get(target, property, receiver) {
    if (property === 'loadRunReceipt') return async () => corrupt;
    return Reflect.get(target, property, receiver);
  } });
  const replay = new TaskEvaluationApplication(replayStore, { async verify() { return principal; } }, f.authorization, f.evaluator, f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 });
  await expect(replay.execute(command)).rejects.toThrow('RUN_STORE_CORRUPT');
  expect(f.state.evaluations).toBe(1);
});
