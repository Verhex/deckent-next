import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { describe, afterEach, expect, it } from 'vitest';
import { FileArtifactStore, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { TaskEvaluationApplication, RunLifecycleApplication, projectRunView, AuditApplication } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { createHmacIntegrity, resolveProductPaths } from '#platform/index.js';
import { main } from '#surfaces/index.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
const request = { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['task'] };
const command = { schemaVersion: 1 as const, commandId: 'evaluate-1', identity, expectedRevision: 2 };
const principal = { id: 'evaluator-user', issuer: 'test', subject: 'subject', assurance: 'os-user' as const, scopeIds: ['s'] };

async function fixture(output: 'complete' | 'partial' | 'malformed' | 'missing' = 'complete', killed = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-evaluation-app-')); roots.push(root);
  const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const };
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), options, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles); stores.push(store);
  await admitRunAttempts(store, [identity]); await mkdir(join(root, 'artifacts'), { mode: 0o700 });
  const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 4096 });
  const bytes = output === 'malformed' ? Buffer.from('{not-json') : Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: output === 'missing' ? 'complete' : output, stdout: 'ok', stderr: '' }));
  const receipt = await artifacts.put('s', bytes); const claim = { request, owner: 'supervisor' };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  if (output !== 'missing') await store.retainDispatchOutput(claim, receipt); await store.finishDispatch(claim, { handle: 'h', exitCode: killed ? 137 : 0, interrupted: killed });
  const state = { allow: true, reads: 0, evaluations: 0, lastEvaluation: null as { evaluator: unknown; criterion: unknown; terminal: unknown } | null };
  const verifier = { async verify() { return principal; } };
  const authorization = { async authorize() { if (!state.allow) throw new Error('POLICY_DENIED'); } };
  const evaluator = { async evaluate(evaluator: unknown, criterion: unknown, terminal: unknown) {
    state.evaluations++; state.lastEvaluation = { evaluator, criterion, terminal }; return 'pass' as const;
  } };
  const app = new TaskEvaluationApplication(store, verifier, authorization, evaluator, artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => 100, timeoutMs: 1000 });
  return { app, store, artifacts, state, authorization, evaluator, receipt, claim, path: join(root, 'ledger.db') };
}

describe.skipIf(process.platform === 'win32')('requires POSIX private FileArtifactStore; ARTIFACT_UNSUPPORTED', () => {
it('rejects caller verdict, evaluator, actor and path fields before ledger reads', async () => {
  const f = await fixture();
  const guarded = new Proxy(f.store, { get(target, property, receiver) {
    if (property === 'loadRunReceipt' || property === 'loadRun' || property === 'load' || property === 'loadBoundDispatch') {
      const method = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => { f.state.reads++; return method.apply(target, args); };
    }
    return Reflect.get(target, property, receiver);
  } });
  const denied = new TaskEvaluationApplication(guarded, { async verify() { return principal; } }, f.authorization, f.evaluator, f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => 100, timeoutMs: 1000 });
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
  }, { async evaluate() { calls = 1; return 'pass' as const; } }, f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => 100, timeoutMs: 1000 });
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
  const replay = new TaskEvaluationApplication(replayStore, { async verify() { return principal; } }, f.authorization, f.evaluator, f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => 100, timeoutMs: 1000 });
  await expect(replay.execute(command)).rejects.toThrow('RUN_STORE_CORRUPT');
  expect(f.state.evaluations).toBe(1);
});

it('parks a host-proven killed exit137 without evaluation and closes at the persisted deadline', async () => {
  const f = await fixture('complete', true);
  const app = new TaskEvaluationApplication(f.store, { async verify() { return principal; } }, f.authorization, f.evaluator, f.artifacts,
    { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => 100, timeoutMs: 1000 });
  const parked = await app.execute(command);
  expect(parked.snapshot.state).toEqual({ kind: 'parked', reason: 'evaluation-not-ready', since: 100, deadline: 1100 });
  expect(parked.snapshot.progress[0]).toMatchObject({ phase: 'awaiting-decision', decision: { reason: 'evaluation-not-ready', deadline: 1100 } });
  expect(f.state.evaluations).toBe(0); expect(await f.store.hasTaskEvaluation(identity, 2)).toBe(false);
  expect(await app.execute(command)).toEqual(parked);
  const closed = await f.store.commitRunLifecycle({ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'expire', action: 'expire',
    expectedRevision: parked.snapshot.revision, now: 1100, timeoutMs: 1000, actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance } });
  expect(closed.snapshot.state).toEqual({ kind: 'terminal', outcome: 'failed', reason: 'park-timeout' });
});
it('refuses a forged attempt identity or corrupt snapshot when replaying a parked evaluation', async () => {
  const f = await fixture('complete', true);
  const make = (store = f.store) => new TaskEvaluationApplication(store, { async verify() { return principal; } }, f.authorization, f.evaluator, f.artifacts,
    { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => 100, timeoutMs: 1000 });
  await make().execute(command);
  await expect(make().execute({ ...command, identity: { ...identity, generation: 2 } })).rejects.toThrow('RUN_COMMAND_CONFLICT');
  const receipt = (await f.store.loadRunReceipt('s', command.commandId))!;
  const corrupt = new Proxy(f.store, { get(target, property, receiver) {
    if (property === 'loadRunReceipt') return async () => ({ ...receipt, snapshot: { ...receipt.snapshot, revision: 99 } });
    return Reflect.get(target, property, receiver);
  } });
  await expect(make(corrupt).execute(command)).rejects.toThrow('RUN_STORE_CORRUPT');
});

it('carries unknown through real ledger to the shared human SDK and CLI decision, preserving audit and unverified labels', async () => {
  const f = await fixture();
  const evaluator = new TaskEvaluationApplication(f.store, { async verify() { return principal; } }, f.authorization,
    { async evaluate() { return 'unknown' as const; } }, f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => 100, timeoutMs: 1000 });
  const waiting = await evaluator.execute(command);
  const integrity = createHmacIntegrity('audit', new Uint8Array(32).fill(1));
  const human = new RunLifecycleApplication(f.store, { async verify() { return principal; } }, { async authorize() {} }, f.authorization,
    audit => new AuditApplication(audit, integrity), () => 200, 1000, 'policy');
  let text = '', received: unknown;
  const layout = resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } });
  const context = { env: { NO_COLOR: '1' }, stdout: { write(value: string) { text += value; } },
    async applyRunLifecycle(_root: string, input: import('#engine/index.js').RunLifecycleCommand) {
      received = input; const receipt = await human.execute(input);
      return { schemaVersion: 1 as const, layout, lifecycle: { schemaVersion: 1 as const, commandId: receipt.commandId, run: projectRunView(receipt.snapshot) } };
    } };
  const decision = { schemaVersion: 1 as const, action: 'accept' as const, scopeId: 's', runId: 'r', taskId: 't', commandId: 'human-accept', expectedRevision: waiting.snapshot.revision };
  const args = ['task', 'accept', '--scope', 's', '--run', 'r', '--task', 't', '--command-id', 'human-accept', '--expected-revision', String(waiting.snapshot.revision)];
  expect(await main([...args, '--lang', 'en'], context)).toBe(0); expect(received).toEqual(decision);
  expect(text).toContain('Accepted — model evidence unverified');
  const sdk = await human.execute(decision); expect(sdk.snapshot.progress[0].acceptedEvidence).toBe('model-unverified');
  text = ''; expect(await main([...args, '--lang', 'tr'], context)).toBe(0); expect(text).toContain('Kabul — model kanıtı doğrulanamadı');
  text = ''; expect(await main([...args, '--json'], context)).toBe(0);
  expect(JSON.parse(text).lifecycle.run).toEqual(projectRunView(sdk.snapshot));
  const original = JSON.parse((await f.store.loadRunReceipt('s', command.commandId))!.command);
  expect(original.evaluation.criteria[0].verdict).toBe('unknown');
});
it('a policy can only narrow unknown to failed and never create acceptance', async () => {
  const f = await fixture();
  const make = (restriction: string) => new TaskEvaluationApplication(f.store, { async verify() { return principal; } }, f.authorization,
    { async evaluate() { return 'unknown' as const; } }, f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 },
    { now: () => 100, timeoutMs: 1000 }, { async decide() { return restriction as 'fail'; } });
  await expect(make('accept').execute(command)).rejects.toThrow('TASK_EVALUATION_INVALID');
  expect(await f.store.loadRunReceipt('s', command.commandId)).toBeNull();
  const failed = await make('fail').execute(command);
  expect(failed.snapshot.progress[0].phase).toBe('failed');
  const record = JSON.parse(failed.command);
  expect(record.unknownDisposition).toBe('fail'); expect(record.evaluation.criteria[0].verdict).toBe('unknown');
});

it('parks a migrated historical unknown without spending another evaluation revision', async () => {
  const f = await fixture();
  const evaluator = new TaskEvaluationApplication(f.store, { async verify() { return principal; } }, f.authorization,
    { async evaluate() { return 'unknown' as const; } }, f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => 100, timeoutMs: 1000 });
  const original = await evaluator.execute(command);
  const oldProgress = original.snapshot.progress.map(task => { return { ...task, decision: undefined, phase: 'evaluating' }; });
  const db = new DatabaseSync(f.path); db.prepare('UPDATE runs SET snapshot=?').run(JSON.stringify({ ...original.snapshot, state: { kind: 'running' }, progress: oldProgress })); db.close();
  const app = new RunLifecycleApplication(f.store, { async verify() { return principal; } }, { async authorize() {} }, f.authorization,
    () => { throw new Error('unexpected decision audit'); }, () => 100, 1000, 'policy');
  const parked = await app.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' });
  expect(parked!.snapshot.progress[0].phase).toBe('awaiting-decision');
  expect(parked!.snapshot.state).toMatchObject({ kind: 'parked', deadline: 1100 });
  expect(JSON.parse((await f.store.loadRunReceipt('s', command.commandId))!.command).evaluation).toEqual(JSON.parse(original.command).evaluation);
});

});

describe.skipIf(process.platform === 'win32')('parked exact-attempt output evidence return', () => {
it('returns recovered output to evaluation once, reparks unknown with the original deadline, and refuses the same evidence twice', async () => {
  const f = await fixture('missing'); let now = 100;
  const app = new TaskEvaluationApplication(f.store, { async verify() { return principal; } }, f.authorization,
    { async evaluate() { return 'unknown' as const; } }, f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => now, timeoutMs: 1000 });
  const parked = await app.execute(command);
  await expect(app.execute({ ...command, commandId: 'no-evidence', expectedRevision: 3 })).rejects.toThrow('TASK_EVALUATION_NOT_READY');
  await f.store.retainDispatchOutput(f.claim, f.receipt); now = 200;
  const returned = await app.execute({ ...command, commandId: 'recovered', expectedRevision: 3 });
  expect(returned.snapshot.progress[0]).toMatchObject({ phase: 'awaiting-decision', decision: { since: 100, deadline: 1100, evidenceDigests: [f.receipt.digest] } });
  expect(returned.snapshot.state).toMatchObject({ kind: 'parked', since: 100, deadline: 1100 });
  expect(JSON.parse(returned.command).evaluation.returnEvidence).toEqual({ kind: 'output', digest: f.receipt.digest });
  await expect(app.execute({ ...command, commandId: 'repeat', expectedRevision: 4 })).rejects.toThrow('TASK_EVALUATION_NOT_READY');
  expect(await app.execute({ ...command, commandId: 'recovered', expectedRevision: 3 })).toEqual(returned);
  expect(parked.snapshot.progress[0].decision!.deadline).toBe(1100);
});
it('accepts recovered complete output by the existing evaluator and refuses an expired return', async () => {
  const f = await fixture('missing'); let now = 100;
  const app = new TaskEvaluationApplication(f.store, { async verify() { return principal; } }, f.authorization, f.evaluator,
    f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => now, timeoutMs: 1000 });
  await app.execute(command); await f.store.retainDispatchOutput(f.claim, f.receipt); now = 1100;
  await expect(app.execute({ ...command, commandId: 'expired', expectedRevision: 3 })).rejects.toThrow('TASK_EVALUATION_NOT_READY');
  now = 200;
  const accepted = await app.execute({ ...command, commandId: 'recovered-pass', expectedRevision: 3 });
  expect(accepted.snapshot.progress[0].phase).toBe('accepted');
  expect(accepted.snapshot.state).toEqual({ kind: 'terminal', outcome: 'completed', reason: 'completed' });
});
it('new output after killed exit137 never invokes the evaluator or extends the deadline', async () => {
  const f = await fixture('missing', true);
  const app = new TaskEvaluationApplication(f.store, { async verify() { return principal; } }, f.authorization, f.evaluator,
    f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => 100, timeoutMs: 1000 });
  const parked = await app.execute(command); await f.store.retainDispatchOutput(f.claim, f.receipt);
  await expect(app.execute({ ...command, commandId: 'killed-recovery', expectedRevision: 3 })).rejects.toThrow('TASK_EVALUATION_NOT_READY');
  expect(await f.store.loadRun('s', 'r')).toEqual(parked.snapshot); expect(f.state.evaluations).toBe(0);
});
it('refuses a recovered output envelope for a different exact Attempt before evaluation', async () => {
  const f = await fixture('missing');
  const app = new TaskEvaluationApplication(f.store, { async verify() { return principal; } }, f.authorization, f.evaluator,
    f.artifacts, { maxEvidenceItems: 2, maxTotalBytes: 4096 }, { now: () => 100, timeoutMs: 1000 });
  const parked = await app.execute(command);
  const wrong = await f.artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity: { ...identity, generation: 2 }, completeness: 'complete', stdout: 'ok', stderr: '' })));
  await f.store.retainDispatchOutput(f.claim, wrong);
  await expect(app.execute({ ...command, commandId: 'wrong-envelope', expectedRevision: 3 })).rejects.toThrow('TASK_EVIDENCE_UNLINKED');
  expect(await f.store.loadRun('s', 'r')).toEqual(parked.snapshot); expect(f.state.evaluations).toBe(0);
});
});
