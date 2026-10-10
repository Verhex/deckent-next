import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { DockerSupervisor, validateDockerTaskProfile, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { DispatchApplication, resolveExecutionRegistry, AuditApplication, RunLifecycleApplication, RunReservationApplication, TaskEvaluationApplication, RunProgressionTurn,
  RunPolicyAuthorization, DispatchPolicyAuthorization, prepareTaskStart, projectRunView, type RunLifecycleCommand } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import type { ArtifactReceipt } from '#capabilities/index.js';
import { policySchema, type AttemptIdentity, type VerifiedPrincipal } from '#domain/index.js';
import { fixtureExecution, fixtureDockerRegistry } from '../support/execution-registry.js';
import { custodyOrDockerProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const human: VerifiedPrincipal = { id: 'human', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['s'] };
const actor = { id: human.id, issuer: human.issuer, subject: human.subject };
const graph = { schemaVersion: 2, revision: 1, tasks: ['task', 'other'].map(id => ({ id, kind: 'fixture', dependencies: [], acceptanceCriteria: ['ok'] })),
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
const report = { schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: { schemaVersion: 1, summary: 'Input required', changedFiles: [], checks: [], openIssues: [],
  exit: { schemaVersion: 1, kind: 'needs-input', question: 'Which region should I use?' } } };
async function fixture(docker = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deckent-input-hold-'))); roots.push(root);
  const artifactRoot = join(root, 'artifacts'); await mkdir(artifactRoot);
  const path = join(root, 'ledger.db'); let now = 10, allowed = true, principal = human, nextId = 0;
  const capacity = { executionSlots: 2, inFlightSlots: 2 };
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, { now: () => now, timeoutMs: 1000 }, 'allow', custodyOrDockerProfiles); stores.push(store);
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity });
  await store.createRun({ commandId: 'create', actor, identity: { runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, execution: docker ? resolveExecutionRegistry(graph, { ...fixtureDockerRegistry(['fixture']), evaluators: [{ id: 'test', version: 1, implementation: { id: 'test-evaluator', version: 1 } }] }, { profile: validateDockerTaskProfile, criterion() {} }) : fixtureExecution(graph), now,
    policy: { schemaVersion: 2, poolId: 'pool', capacity, ordering: ['task', 'other'] } });
  const policy = { async load() { return policySchema.parse({ schemaVersion: 1, revision: 'policy', restrictions: [], grants: allowed ? [
    { id: 'run', effect: 'allow', actions: ['inspect', 'cancel', 'reserve'], scopes: ['s'], principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'run', ids: ['r'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output'], scopes: ['s'], principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'attempt', ids: 'all' } },
  ] : [] }); } };
  const verifier = { async verify() { return principal; } }, runPolicy = new RunPolicyAuthorization(policy), attemptPolicy = new DispatchPolicyAuthorization(policy);
  const authorization = { authorize: (identity: AttemptIdentity, value: VerifiedPrincipal) => attemptPolicy.authorizeIdentity('evaluate', identity, value) };
  const integrity = createHmacIntegrity('audit', new Uint8Array(32).fill(1));
  const lifecycle = new RunLifecycleApplication(store, verifier, runPolicy, authorization, audit => new AuditApplication(audit, integrity), () => now, 1000, 'policy');
  const data = new Map<string, Uint8Array>();
  const artifacts = {
    async put(scopeId: string, bytes: Uint8Array): Promise<ArtifactReceipt> {
      const digest = createHash('sha256').update(bytes).digest('hex'); data.set(digest, bytes);
      return { schemaVersion: 1, scopeId, digest, byteLength: bytes.byteLength };
    },
    async read(scopeId: string, receipt: ArtifactReceipt) {
      const bytes = data.get(receipt.digest);
      if (!bytes || receipt.scopeId !== scopeId || bytes.byteLength !== receipt.byteLength || createHash('sha256').update(bytes).digest('hex') !== receipt.digest) throw new Error('ARTIFACT_INVALID');
      return bytes;
    },
    async prepareReadOnlyFile(scopeId: string, receipt: ArtifactReceipt) { const path = join(artifactRoot, receipt.digest), bytes = await this.read(scopeId, receipt); await writeFile(path, bytes); return { path, bytes }; },
  };
  const evaluator = { evaluate: vi.fn(async () => 'pass' as 'pass' | 'fail' | 'unknown') };
  const evaluation = new TaskEvaluationApplication(store, verifier, authorization, evaluator, artifacts, { maxEvidenceItems: 2, maxTotalBytes: 8192 },
    { now: () => now, timeoutMs: 1000 }, { async decide() { return 'fail'; } });
  const reservation = new RunReservationApplication(store, verifier, runPolicy, { async authorize() {} }, { now: () => now, attemptId: () => `new-${++nextId}` });
  const read = async () => (await store.loadRun('s', 'r'))!;
  const command = async (action: RunLifecycleCommand['action'], extra: object = {}) => ({ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: action,
    expectedRevision: (await read()).revision, action, ...extra });
  const reserve = async (taskId: string, attemptId = `${taskId}-first`) => {
    const run = await read(), identity = { ...run.identity, taskId, attemptId, generation: 1 };
    await store.reserveRunTasks({ scopeId: 's', runId: 'r', commandId: `reserve-${attemptId}`, actor, expectedRevision: run.revision, now, identities: [identity] });
    return identity;
  };
  const exit = async (identity: AttemptIdentity, stdout = JSON.stringify(report), exitCode = 0, completeness = 'complete') => {
    const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity, workspace: '/fixture/workspace', argv: ['fixture-command'] } };
    await store.claimDispatch(docker ? { ...claim, profile: await simulatedDocker(root).supervisor.captureProfile() } : dispatchAdmission(claim)); await grantTestLaunch(store, claim);
    const output = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness, stdout, stderr: '' })));
    await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: identity.attemptId, exitCode, interrupted: false });
    return { schemaVersion: 1, commandId: `evaluate-${identity.attemptId}`, identity, expectedRevision: (await read()).revision };
  };
  const auditCount = () => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n); } finally { db.close(); } };
  return { root, store, path, read, command, reserve, exit, evaluation, evaluator, lifecycle, reservation, artifacts, verifier, attemptPolicy, auditCount,
    time(value: number) { now = value; }, deny() { allowed = false; }, allow() { allowed = true; }, agent() { principal = { ...human, assurance: 'workload-verified' }; } };
}

it('parks a typed input exit, never auto-retries or accepts it, then delivers the answer to one new attempt', async () => {
  const f = await fixture(), identity = await f.reserve('task'), evaluate = await f.exit(identity);
  const parked = await f.evaluation.execute(evaluate), run = parked.snapshot;
  expect(run.state).toMatchObject({ kind: 'parked', reason: 'needs-input', deadline: 1010 });
  expect(projectRunView(run).tasks[0]!.decision).toMatchObject({ reason: 'needs-input', question: report.report.exit.question });
  expect(f.evaluator.evaluate).not.toHaveBeenCalled();
  expect(await f.evaluation.execute(evaluate)).toEqual(parked);
  await expect(f.reservation.reserve({ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'blind-retry', expectedRevision: run.revision })).rejects.toThrow();
  await expect(f.lifecycle.execute(await f.command('accept', { taskId: 'task' }))).rejects.toMatchObject({ code: 'RUN_DECISION_NOT_READY' });
  const answer = await f.command('answer', { taskId: 'task', answer: 'Use the EU region.' });
  const answered = await f.lifecycle.execute(answer);
  expect(await f.lifecycle.execute(answer)).toEqual(answered); expect(f.auditCount()).toBe(1);
  expect(await f.store.load('s', identity.attemptId)).toMatchObject({ lastObservation: { result: { kind: 'exited' } } });
  expect(await f.store.loadBoundDispatch(identity)).toMatchObject({ terminal: { exitCode: 0 } });
  const next = await f.reservation.reserve({ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'continue', expectedRevision: answered.snapshot.revision });
  const continued = next.identities.find(value => value.taskId === 'task')!;
  expect(continued.generation).toBe(2); expect(continued.attemptId).not.toBe(identity.attemptId);
  expect(await f.store.loadBoundDispatch(identity)).toMatchObject({ terminal: { exitCode: 0 } });
  const start = await prepareTaskStart(continued, f.store, f.artifacts, f.verifier, f.attemptPolicy, { artifacts: { maxInputs: 4, maxBytes: 8192 } });
  expect(start.dependencyContext!.text).toContain('Use the EU region.');
  const file = start.handoffInputs.find(value => value.target === '/deckent/inputs/_needs-input.json')!;
  expect(JSON.parse(Buffer.from(await f.artifacts.read('s', file.receipt)).toString())).toMatchObject({ source: identity, question: report.report.exit.question, answer: 'Use the EU region.' });
  await expect(f.lifecycle.execute({ ...answer, answer: 'Changed answer' })).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
});

it('holds new attempts with a reason, preserves existing execution/evaluation, and resumes under audited replay', async () => {
  const f = await fixture(), identity = await f.reserve('task');
  const hold = await f.command('hold', { holdReason: 'Wait for the release window' }), held = await f.lifecycle.execute(hold);
  expect(held.snapshot.progress[0]!.phase).toBe('active');
  await expect(f.store.reserveRunTasks({ scopeId: 's', runId: 'r', commandId: 'blocked', expectedRevision: held.snapshot.revision, now: 11, actor,
    identities: [{ ...identity, taskId: 'other', attemptId: 'blocked' }] })).rejects.toMatchObject({ code: 'RUN_TASK_NOT_READY' });
  expect(await f.lifecycle.execute(hold)).toEqual(held); expect(f.auditCount()).toBe(1);
  const lookup = { actor, after: null, limit: 4 };
  expect((await f.store.listRunProgression(lookup)).items).toEqual([{ scopeId: 's', runId: 'r' }]);
  const evaluated = await f.evaluation.execute(await f.exit(identity, 'ordinary output'));
  expect(evaluated.snapshot.progress[0]!.phase).toBe('accepted'); expect(evaluated.snapshot.state).toMatchObject({ reason: 'operator-hold', note: 'Wait for the release window' });
  expect((await f.store.listRunProgression(lookup)).items).toEqual([]);
  const resume = await f.command('resume'), resumed = await f.lifecycle.execute(resume);
  expect(resumed.snapshot.state).toEqual({ kind: 'running' }); expect(await f.lifecycle.execute(resume)).toEqual(resumed);
  expect(f.auditCount()).toBe(2);
  expect((await f.reservation.reserve({ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'after-hold', expectedRevision: resumed.snapshot.revision })).identities.map(value => value.taskId)).toEqual(['other']);
});

it('checks fresh policy before hold/resume/answer and their replay; denial writes no receipt or audit', async () => {
  const f = await fixture(), hold = await f.command('hold', { holdReason: 'Operator requested' }), before = await f.read();
  f.deny(); await expect(f.lifecycle.execute(hold)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(await f.read()).toEqual(before); expect(f.auditCount()).toBe(0);
  f.allow(); await f.lifecycle.execute(hold); f.deny();
  await expect(f.lifecycle.execute(hold)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(f.lifecycle.execute(await f.command('resume'))).rejects.toMatchObject({ code: 'POLICY_DENIED' }); expect(f.auditCount()).toBe(1);
  f.allow(); await f.lifecycle.execute(await f.command('resume'));
  const identity = await f.reserve('task'); await f.evaluation.execute(await f.exit(identity));
  const answer = await f.command('answer', { taskId: 'task', answer: 'EU' }); f.deny();
  await expect(f.lifecycle.execute(answer)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect((await f.read()).progress[0]!.phase).toBe('awaiting-decision');
  f.allow(); f.agent(); await expect(f.lifecycle.execute(answer)).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
});

it('policy-authorized workload hold/resume cannot answer or resume the input decision', async () => {
  const f = await fixture(); f.agent();
  await f.lifecycle.execute(await f.command('hold', { holdReason: 'Scoped automation hold' }));
  const resume = await f.command('resume'), resumed = await f.lifecycle.execute(resume);
  expect(await f.lifecycle.execute(resume)).toEqual(resumed);
  const identity = await f.reserve('task'); await f.evaluation.execute(await f.exit(identity));
  await expect(f.lifecycle.execute(await f.command('resume', { commandId: 'resume-input' }))).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
});

it('the progression turn drains a held task without taking a new reservation', async () => {
  const f = await fixture(), identity = await f.reserve('task'); await f.lifecycle.execute(await f.command('hold', { holdReason: 'Pause new work' }));
  const reserve = vi.fn(), execute = vi.fn(async () => { await f.exit(identity, 'ordinary output'); });
  const turn = new RunProgressionTurn({ read: f.read, reserve, execute, async evaluationRecorded() { return false; },
    async evaluate(command) { await f.evaluation.execute(command); return 'recorded'; } }, 2, { commandId: () => 'turn-eval' });
  const result = await turn.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' }, new AbortController().signal);
  expect(result.attempted).toBe(1); expect(execute).toHaveBeenCalledTimes(1); expect(reserve).not.toHaveBeenCalled();
  expect(result.run.tasks[0]!.phase).toBe('accepted'); expect(result.run.state).toMatchObject({ reason: 'operator-hold' });
});

it('expiry and operator close preserve live custody, and a needs-input answer cannot reset its deadline', async () => {
  const f = await fixture(); await f.reserve('task'); await f.lifecycle.execute(await f.command('hold', { holdReason: 'Wait' }));
  await expect(f.lifecycle.execute(await f.command('close'))).rejects.toMatchObject({ code: 'RUN_DECISION_NOT_READY' });
  f.time(1010); await f.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' });
  expect((await f.read()).progress[0]!.phase).toBe('active'); expect((await f.read()).state.kind).toBe('parked');
  const g = await fixture(), next = await g.reserve('task'); await g.evaluation.execute(await g.exit(next)); g.time(1010);
  await expect(g.lifecycle.execute(await g.command('answer', { taskId: 'task', answer: 'Late' }))).rejects.toMatchObject({ code: 'RUN_DECISION_EXPIRED' });
  await g.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' }); expect((await g.read()).state).toMatchObject({ kind: 'terminal', outcome: 'failed', reason: 'park-timeout' });
});

it('audit failure rolls back hold and never consumes the command id', async () => {
  const f = await fixture(), run = await f.read();
  await expect(f.store.commitRunLifecycle({ schemaVersion: 1, commandId: 'failed-audit', scopeId: 's', runId: 'r', action: 'hold', holdReason: 'Wait',
    expectedRevision: run.revision, actor: { ...actor, assurance: 'os-user' }, now: 10, timeoutMs: 1000 }, () => { throw new Error('AUDIT_UNAVAILABLE'); })).rejects.toThrow('AUDIT_UNAVAILABLE');
  expect(await f.read()).toEqual(run); expect(await f.store.loadRunReceipt('s', 'failed-audit')).toBeNull();
});

it('an answer preserves an operator hold, and every subsequent question keeps earlier attempt evidence readable', async () => {
  const f = await fixture(), first = await f.reserve('task'); await f.evaluation.execute(await f.exit(first));
  await f.lifecycle.execute(await f.command('hold', { holdReason: 'Release window' }));
  await f.lifecycle.execute(await f.command('answer', { taskId: 'task', answer: 'EU' }));
  expect((await f.read()).state).toMatchObject({ reason: 'operator-hold' });
  await f.lifecycle.execute(await f.command('resume'));
  const next = await f.reservation.reserve({ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'second-attempt', expectedRevision: (await f.read()).revision });
  const second = next.identities.find(value => value.taskId === 'task')!;
  await f.evaluation.execute(await f.exit(second));
  await f.lifecycle.execute(await f.command('answer', { commandId: 'second-answer', taskId: 'task', answer: 'EU west' }));
  const third = await f.reservation.reserve({ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'third-attempt', expectedRevision: (await f.read()).revision });
  expect(third.identities[0]!.generation).toBe(3);
  expect((await f.read()).previousBindings!.map(binding => binding.identity)).toEqual([first, second]);
  expect(await f.store.loadBoundDispatch(first)).toMatchObject({ terminal: { exitCode: 0 } });
  expect(await f.store.loadBoundDispatch(second)).toMatchObject({ terminal: { exitCode: 0 } });
  await expect(f.evaluation.execute({ schemaVersion: 1, commandId: 'stale-old-evaluation', identity: first, expectedRevision: (await f.read()).revision })).rejects.toMatchObject({ code: 'TASK_EVALUATION_STALE' });
});

it('a failed or incomplete process cannot manufacture a human input wait from its report', async () => {
  const f = await fixture(), first = await f.reserve('task'); f.evaluator.evaluate.mockResolvedValue('fail');
  const failed = await f.evaluation.execute(await f.exit(first, JSON.stringify(report), 7));
  expect(failed.snapshot.progress[0]!.phase).toBe('failed'); expect(failed.snapshot.progress[0]!.decision).toBeUndefined();
  const g = await fixture(), second = await g.reserve('task'), command = await g.exit(second, JSON.stringify(report), 0, 'partial');
  await expect(g.evaluation.execute(command)).rejects.toMatchObject({ code: 'TASK_EVIDENCE_UNLINKED' });
  expect((await g.read()).progress[0]!.phase).toBe('evaluating');
});

it('cancellation of an input wait cannot be undone by answering or resume', async () => {
  const f = await fixture(), first = await f.reserve('task'); await f.evaluation.execute(await f.exit(first));
  const run = await f.read();
  await f.store.cancelRun({ commandId: 'cancel', scopeId: 's', runId: 'r', expectedRevision: run.revision, actor });
  await expect(f.lifecycle.execute(await f.command('answer', { taskId: 'task', answer: 'EU' }))).rejects.toMatchObject({ code: 'RUN_DECISION_NOT_READY' });
  expect((await f.read()).cancelRequested).toBe(true); expect((await f.read()).progress[0]!.phase).toBe('cancelled');
});


function simulatedDocker(workspaceRoot: string, handoffInputs: readonly { target: string; path: string; receipt: ArtifactReceipt }[] = [],
  mutate: (mounts: object[]) => object[] = mounts => mounts) {
  let state = 'missing', label = '', mounts: object[] = [];
  const calls: string[][] = [];
  const runner = async ({ args }: { args: readonly string[] }) => {
    const command = [...args], at = command[0] === '--host' ? 2 : 0, verb = command[at]; calls.push(command);
    if (verb === 'context') return { stdout: JSON.stringify({ Host: 'unix:///fixture/docker.sock' }), stderr: '' };
    if (verb === 'info') return { stdout: 'fixture-daemon', stderr: '' };
    if (verb === 'inspect') {
      if (state === 'missing') throw { stderr: 'No such object: ' + command[at + 1] };
      return { stdout: JSON.stringify([{ Id: 'c'.repeat(64), Image: 'sha256:' + 'a'.repeat(64), Config: { Labels: { 'deckent.request': label } },
        Mounts: mounts, State: { Status: state, ExitCode: 0 } }]), stderr: '' };
    }
    if (verb === 'create') {
      label = command[command.indexOf('--label') + 1]!.slice('deckent.request='.length); state = 'created';
      mounts = mutate(command.flatMap((arg, index) => {
        if (arg !== '--mount') return [];
        const fields = Object.fromEntries(command[index + 1]!.split(',').map(part => part.split('=')));
        return [{ Type: fields['type'], Source: fields['src'], Destination: fields['dst'], RW: !command[index + 1]!.includes(',readonly') }];
      })); return { stdout: 'c'.repeat(64), stderr: '' };
    }
    if (verb === 'start') { state = 'exited'; return { stdout: 'answer consumed', stderr: '' }; }
    throw new Error('Unexpected controlled Docker command');
  };
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot, imageId: 'sha256:' + 'a'.repeat(64), uid: 1000, gid: 1000,
    cpus: 1, memoryBytes: 268435456, pids: 64, tmpBytes: 16777216, logMaxSizeKiB: 64, logMaxFiles: 2,
    deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536, handoffInputs }, runner);
  return { supervisor, calls };
}

it('needs-input → audited answer → generation 2 dispatches with the exact read-only answer mount and reaches acceptance (controlled Docker daemon)', async context => {
  if (process.platform === 'win32') {
    expect(() => simulatedDocker('C:\\fixture')).toThrow('SUPERVISOR_OPTIONS_INVALID');
    context.skip('SUPERVISOR_OPTIONS_INVALID: POSIX Docker executable/path fixture; native Windows Docker not exercised');
  }
  const f = await fixture(true), first = await f.reserve('task'); await f.evaluation.execute(await f.exit(first));
  await f.lifecycle.execute(await f.command('answer', { taskId: 'task', answer: 'Use EU' }));
  const workspaces = join(f.root, 'workspaces'); await mkdir(workspaces);
  const dispatched: AttemptIdentity[] = [], creates: string[][] = [];
  let commandId = 0;
  const turn = new RunProgressionTurn({ read: f.read,
    async reserve(command) { await f.reservation.reserve(command); return 'reserved'; },
    async execute(identity) {
      const start = await prepareTaskStart(identity, f.store, f.artifacts, f.verifier, f.attemptPolicy, { artifacts: { maxInputs: 4, maxBytes: 8192 } });
      const workspace = join(workspaces, identity.attemptId); await mkdir(workspace);
      const daemon = simulatedDocker(workspaces, start.handoffInputs);
      const outcome = await new DispatchApplication(f.store, daemon.supervisor, f.verifier, f.attemptPolicy, 'worker', f.artifacts)
        .execute({ protocolVersion: 1, identity, workspace, argv: ['fixture-command'] });
      expect(outcome.kind).toBe('terminal'); dispatched.push(identity); creates.push(...daemon.calls.filter(args => args.includes('create')));
    },
    async evaluate(command) { await f.evaluation.execute(command); return 'recorded'; }, evaluationRecorded: (identity, revision) => f.store.hasTaskEvaluation(identity, revision),
  }, 2, { commandId: () => 'eval-' + ++commandId });
  const result = await turn.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' }, new AbortController().signal);
  const next = dispatched.find(value => value.taskId === 'task')!; expect(next.generation).toBe(2); expect(next.attemptId).not.toBe(first.attemptId);
  expect(creates.find(args => args.some(arg => arg.includes('dst=/deckent/inputs/_needs-input.json,readonly')))).toBeDefined();
  expect(result.run.tasks.find(task => task.id === 'task')!.phase).toBe('accepted');
  expect(await f.store.loadBoundDispatch(first)).toMatchObject({ terminal: { exitCode: 0 } });
  expect(await f.store.loadBoundDispatch(next)).toMatchObject({ launch: 'granted', terminal: { exitCode: 0 }, output: { scopeId: 's' } });
});

it('parks progression under fresh cancel policy/CAS/audit and preserves active custody across expiry and explicit resume', async () => {
  const f = await fixture(), identity = await f.reserve('task'), before = await f.read();
  const park = { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'park', expectedRevision: before.revision, failureCode: 'SUPERVISOR_CONTROL_FAILED' };
  f.deny(); await expect(f.lifecycle.parkProgression(park)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(await f.read()).toEqual(before); expect(f.auditCount()).toBe(0);
  f.allow(); const parked = await f.lifecycle.parkProgression(park);
  expect(parked.snapshot.state).toEqual({ kind: 'parked', reason: 'progression-failed', failureCode: park.failureCode, since: 10, deadline: 1010 });
  expect(await f.lifecycle.parkProgression(park)).toEqual(parked); expect(f.auditCount()).toBe(1);
  expect((await f.store.listRunProgression({ actor, after: null, limit: 8 })).items).toEqual([]);
  await expect(f.store.commitRunLifecycle({ ...park, commandId: 'missing-audit', expectedRevision: parked.snapshot.revision,
    action: 'park-progression', actor: { ...actor, assurance: 'os-user' }, now: 10, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
  const restarted = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, { now: () => 10, timeoutMs: 1000 }, 'forbid', custodyOrDockerProfiles);
  try { expect((await restarted.listRunProgression({ actor, after: null, limit: 8 })).items).toEqual([]); expect((await restarted.loadRun('s', 'r'))!.state).toEqual(parked.snapshot.state); } finally { restarted.close(); }
  await f.lifecycle.execute(await f.command('resume'));
  expect((await f.read()).progress[0]!.phase).toBe('active'); expect((await f.read()).bindings[0]!.identity).toEqual(identity);
  const fresh = await f.read();
  await expect(f.lifecycle.parkProgression({ ...park, commandId: 'stale', expectedRevision: before.revision })).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
  await f.lifecycle.parkProgression({ ...park, commandId: 'park-again', expectedRevision: fresh.revision });
  f.time(1010); await f.lifecycle.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' });
  expect((await f.read()).state.kind).toBe('parked'); expect((await f.read()).progress[0]!.phase).toBe('active');
  expect((await f.read()).bindings[0]!.identity).toEqual(identity);
});

it('progression park audit failure rolls back and cannot consume a command or alter custody', async () => {
  const f = await fixture(); await f.reserve('task'); const before = await f.read();
  await expect(f.store.commitRunLifecycle({ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'park-audit-failed', expectedRevision: before.revision,
    action: 'park-progression', failureCode: 'SUPERVISOR_CONTROL_FAILED', actor: { ...actor, assurance: 'os-user' }, now: 10, timeoutMs: 1000 }, () => { throw new Error('AUDIT_UNAVAILABLE'); })).rejects.toThrow('AUDIT_UNAVAILABLE');
  expect(await f.read()).toEqual(before); expect(await f.store.loadRunReceipt('s', 'park-audit-failed')).toBeNull();
});


it.for(['writable-realized', 'foreign-scope', 'duplicate-target', 'arbitrary-target'] as const)(
  'the answer mount refuses %s before worker start (controlled daemon)', async (kind, context) => {
    if (process.platform === 'win32') {
      expect(() => simulatedDocker('C:\\fixture')).toThrow('SUPERVISOR_OPTIONS_INVALID');
      context.skip('SUPERVISOR_OPTIONS_INVALID: POSIX Docker fixture unavailable');
    }
    const f = await fixture(), root = join(f.root, 'workspaces'), workspace = join(root, 'attempt'); await mkdir(workspace, { recursive: true });
    const receipt = await f.artifacts.put('s', Buffer.from('answer')), path = (await f.artifacts.prepareReadOnlyFile('s', receipt)).path;
    const input = { receipt: kind === 'foreign-scope' ? { ...receipt, scopeId: 'other' } : receipt, path,
      target: kind === 'arbitrary-target' ? '/deckent/inputs/_needs-input.json/../escape' : '/deckent/inputs/_needs-input.json' };
    if (kind === 'arbitrary-target') { expect(() => simulatedDocker(root, [input])).toThrow('SUPERVISOR_OPTIONS_INVALID'); return; }
    const daemon = simulatedDocker(root, kind === 'duplicate-target' ? [input, input] : [input], mounts => kind === 'writable-realized'
      ? mounts.map(mount => ({ ...mount, ...((mount as { Destination: string }).Destination === input.target ? { RW: true } : {}) })) : mounts);
    await expect(daemon.supervisor.execute({ protocolVersion: 1, identity: { runId: 'r', taskId: 'task', attemptId: 'next', scopeId: 's', layoutRevision: 'l', generation: 2 },
      workspace, argv: ['fixture-command'] })).rejects.toMatchObject({ code: kind === 'writable-realized' ? 'SUPERVISOR_IDENTITY_CONFLICT' : 'SUPERVISOR_REQUEST_INVALID' });
    expect(daemon.calls.some(args => args.includes('start'))).toBe(false);
  });
