import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { FileArtifactStore, GitWorkspaceBroker, GitRunWorkspaceProvider, GitWorkspacePatchSource, DockerSupervisor,
  openSqliteAttemptStore, readWorkspace, snapshotDigest, SnapshotBudget, applyAcceptedPredecessorPatches } from '#adapters/index.js';
import { RunWorkspaceAcquisitionApplication, WorkspacePatchApplication, TaskEvaluationApplication, TaskPatchStartApplication,
  TaskHandoffApplication, recordAttemptHandoffStart, readAttemptHandoffEvents,
  patchDigest, type WorkspaceLease } from '#engine/index.js';
import { processExitTerminalEvaluator, type ArtifactStore } from '#capabilities/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch, custodyPrincipal } from '../support/custody.js';

const exec = promisify(execFile), roots: string[] = [], stores: Awaited<ReturnType<typeof openSqliteAttemptStore>>[] = [];
const limits = { maxBytes: 65536, maxEntries: 100, maxDepth: 10, maxPathBytes: 256 };
const source = { scopeId: 's', runId: 'r', taskId: 'a', attemptId: 'a1', generation: 1, layoutRevision: 'l' };
const target = { ...source, taskId: 'b', attemptId: 'b1' };
const principal = custodyPrincipal, actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
const verifier = { async verify() { return principal; } }, authorization = { async authorizeIdentity() {} };
afterEach(async () => {
  vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(context: TestContext, verdict: 'accepted' | 'failed' = 'accepted') {
  if (process.platform !== 'linux') {
    await expect(readWorkspace(join(tmpdir(), 'handoff-never-created'), new SnapshotBudget(limits, Date.now() + 10000))).rejects.toMatchObject({ code: 'PATCH_UNSAFE' });
    context.skip('PATCH_UNSAFE: real pre-access refusal verified; Linux descriptor-relative Git chain verify-not-run');
  }
  const root = await mkdtemp(join(tmpdir(), 'handoff-local-')); roots.push(root);
  const sourceRoot = join(root, 'source'), workspaceRoot = join(root, 'workspaces');
  await mkdir(sourceRoot); await mkdir(workspaceRoot); await mkdir(join(root, 'artifacts'), { mode: 0o700 });
  const git = async (...args: string[]) => (await exec('git', ['-C', sourceRoot, ...args], { timeout: 10000 })).stdout.trim();
  await git('init'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(sourceRoot, 'tracked'), 'base\n'); await writeFile(join(sourceRoot, 'removed'), 'remove me\n');
  await git('add', '.'); await git('commit', '-m', 'base'); const base = await git('rev-parse', 'HEAD');
  const gitExecutable = (await exec('which', ['git'])).stdout.trim();
  const options = { sourceRoot, workspaceRoot, gitExecutable, timeoutMs: 10000, outputBytes: 65536 };
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' },
    { now: Date.now, timeoutMs: 1000 }, 'allow', custodyProfiles); stores.push(store);
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: [
    { id: 'a', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'], workInput: {
      schemaVersion: 1, task: 'Produce retained changes', scope: { paths: ['tracked', 'removed', 'added'] }, acceptance: 'Retained patch and zero exit',
      model: { channelId: 'fixture-channel', modelId: 'fixture-model', auxiliaryModelIds: [] } } },
    { id: 'b', kind: 'fixture', dependencies: [{ taskId: 'a', startFrom: 'accepted-patch' as const }], acceptanceCriteria: ['exit'] },
  ], criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  // Trusted fixture admission, as in coding-change: profile compilation is outside this chain's proof.
  const uncompiled = { ...graph, tasks: graph.tasks.map(task => {
    const { workInput: _input, ...rest } = task; void _input; return rest;
  }) };
  const execution = structuredClone(fixtureExecution(uncompiled)); execution.criteria[0]!.evaluator.implementation = { id: 'process-exit', version: 1 };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  await store.createRun({ commandId: 'create', actor, identity: { scopeId: 's', runId: 'r', layoutRevision: 'l' }, now: 0, graph, execution,
    policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['a', 'b'] } });
  await store.reserveRunTasks({ commandId: 'reserve-a', actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: [source] });
  const acquisition = new RunWorkspaceAcquisitionApplication(store, new GitRunWorkspaceProvider(new GitWorkspaceBroker(options)));
  const producer = await acquisition.acquire(source);
  // Controlled local producer, not a Docker/native worker or an isolation acceptance test.
  await exec(process.execPath, ['-e', "const fs=require('node:fs');fs.writeFileSync('tracked','accepted\\n');fs.writeFileSync('added','added\\n');fs.unlinkSync('removed');"], { cwd: producer.workspace, timeout: 10000 });
  await chmod(join(producer.workspace, 'added'), 0o755);
  expect(await readFile(join(producer.workspace, 'tracked'), 'utf8')).toBe('accepted\n');
  const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: limits.maxBytes });
  const result = await artifacts.put('s', Buffer.from('accepted output'));
  const report = { schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: { schemaVersion: 1,
    summary: 'done', changedFiles: [], checks: [], openIssues: [], handoff: { toTask: 'b', summary: 'Use result', artifacts: [{ name: 'result', digest: result.digest }], openQuestions: [] } } };
  const output = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity: source, completeness: 'complete', stdout: JSON.stringify(report), stderr: '', files: [{ name: 'result', status: 'collected', receipt: result }] })));
  const claim = { owner: principal.id, request: { protocolVersion: 1 as const, identity: source, workspace: producer.workspace, argv: ['fixture'] } };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  await store.retainDispatchOutput(claim, output); const exitCode = verdict === 'accepted' ? 0 : 1;
  await store.finishDispatch(claim, { handle: 'fixture', exitCode, interrupted: false });
  // Only stopped supervisor custody is simulated. Real Git source, snapshots, patch retention and evaluation follow.
  vi.spyOn(DockerSupervisor, 'restoreProfile').mockResolvedValue({ async observe() {
    return { handle: 'fixture', result: { kind: 'exited', exitCode } };
  } } as unknown as DockerSupervisor);
  const prepared = await new WorkspacePatchApplication(store, artifacts, verifier, authorization, limits.maxBytes, 'enforce')
    .prepare(source, new GitWorkspacePatchSource(options, limits, store), store);
  const evaluation = await new TaskEvaluationApplication(store, verifier, { async authorize() {} }, processExitTerminalEvaluator,
    artifacts, { maxEvidenceItems: 1, maxTotalBytes: limits.maxBytes }, { now: Date.now, timeoutMs: 1000 })
    .execute({ schemaVersion: 1, commandId: 'evaluate-a', identity: source, expectedRevision: (await store.loadRun('s', 'r'))!.revision });
  expect(evaluation.snapshot.progress[0]!.phase).toBe(verdict);
  if (verdict === 'accepted') await store.reserveRunTasks({ commandId: 'reserve-b', actor, scopeId: 's', runId: 'r',
    expectedRevision: evaluation.snapshot.revision, now: 100, identities: [target] });
  const resolve = (port: ArtifactStore = artifacts) => new TaskPatchStartApplication(store, port, verifier, authorization, limits.maxBytes).resolve(target);
  const tree = async (lease: WorkspaceLease) => readWorkspace(lease.workspace, new SnapshotBudget(limits, Date.now() + 10000));
  const observation = join(root, 'consumer-observation.json');
  const launch = vi.fn(async (lease: WorkspaceLease) => exec(process.execPath, ['-e',
    "const fs=require('node:fs');const value=fs.readFileSync('tracked','utf8');fs.writeFileSync(process.argv[1],JSON.stringify({value}));fs.writeSync(1,value);", observation],
  { cwd: lease.workspace, timeout: 10000 }));
  // This composition harness connects the same owners; negative cases traverse this path through the launch boundary.
  const start = async (port: ArtifactStore = artifacts) => {
    const patches = await resolve(port);
    const handoff = await new TaskHandoffApplication(store, verifier, authorization, artifacts, { maxBytes: limits.maxBytes, maxSharedNotes: 10, promptBytes: 8192 }).resolve(target);
    const lease = await acquisition.acquire(target);
    const applied = await applyAcceptedPredecessorPatches(lease, options, limits, patches);
    await recordAttemptHandoffStart(store, target, [...handoff.events, ...applied.map(value => ({ kind: 'workspace-started-from-patch' as const, source: patches[0]!.source, digest: value.digest }))]);
    return launch(lease);
  };
  return { store, sourceRoot, acquisition, artifacts, prepared, options, base, resolve, tree, producer, result, evaluation, start, launch, observation };
}

it('producer → retained patch → evaluation → acceptance → dependent proves ledger G1 and exact working tree G2 separately', async context => {
  const f = await fixture(context), starts = await f.resolve();
  expect(starts).toHaveLength(1); expect(starts[0]!.source).toEqual(source);
  expect(starts[0]!.receipt).toEqual((await f.store.loadBoundDispatch(source))!.patch);
  expect(starts[0]!.receipt.digest).toBe(patchDigest(JSON.stringify(f.prepared.patch)));
  expect(JSON.parse(f.evaluation.command).evaluation.workspaceChange).toEqual({ schemaVersion: 1, patchDigest: f.prepared.receipt.digest, changedFiles: 3 });
  const handoff = await new TaskHandoffApplication(f.store, verifier, authorization, f.artifacts, { maxBytes: limits.maxBytes, maxSharedNotes: 10, promptBytes: 8192 }).resolve(target);
  expect(handoff.events[0]!.source).toEqual(source);
  const lease = await f.acquisition.acquire(target), expected = await f.tree(f.producer);
  expect(snapshotDigest(await f.tree(lease))).not.toBe(snapshotDigest(expected)); // G1 alone cannot satisfy G2.
  const applied = await applyAcceptedPredecessorPatches(lease, f.options, limits, starts);
  const events = [...handoff.events, ...applied.map(value => ({ kind: 'workspace-started-from-patch' as const, source: starts[0]!.source, digest: value.digest }))];
  await recordAttemptHandoffStart(f.store, target, events);
  const retained = await readAttemptHandoffEvents(f.store, target);
  expect(retained).toEqual({ schemaVersion: 1, identity: target, events }); // G1 durable exact identity, output and patch digests.
  expect(retained!.events.map(event => event.kind)).toEqual(['handoff-received', 'workspace-started-from-patch']);
  expect(await f.tree(lease)).toEqual(expected); // G2 includes all paths, additions/deletions, content and executable mode.
  expect(snapshotDigest(await f.tree(lease))).toBe(f.prepared.patch.snapshotDigest);
  expect(await readFile(join(lease.workspace, 'tracked'), 'utf8')).toBe('accepted\n');
  const consumed = await f.start();
  expect(f.launch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(f.observation, 'utf8'))).toEqual({ value: 'accepted\n' });
  expect(consumed.stdout).toBe('accepted\n');
  expect(lease.baseCommit).toBe(f.base); expect(await readFile(join(f.sourceRoot, 'tracked'), 'utf8')).toBe('base\n');
  expect(await applyAcceptedPredecessorPatches(lease, f.options, limits, starts)).toEqual(applied);
  await recordAttemptHandoffStart(f.store, target, events); expect(await readAttemptHandoffEvents(f.store, target)).toEqual(retained);
  const reopened = await openSqliteAttemptStore(join(f.sourceRoot, '..', 'ledger.db'), { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' },
    { now: Date.now, timeoutMs: 1000 }, 'forbid', custodyProfiles); stores.push(reopened);
  expect(await readAttemptHandoffEvents(reopened, target)).toEqual(retained);
  expect((await reopened.loadBoundDispatch(source))!.patch).toEqual(f.prepared.receipt);
});

it('a producer with retained output and patch but failed acceptance cannot reserve or start its dependent', async context => {
  const f = await fixture(context, 'failed'), allocate = vi.spyOn(f.acquisition, 'acquire');
  await expect(f.store.reserveRunTasks({ commandId: 'reserve-b', actor, scopeId: 's', runId: 'r', expectedRevision: f.evaluation.snapshot.revision,
    now: 100, identities: [target] })).rejects.toThrow();
  await expect(f.start()).rejects.toThrow(); // No dependent Attempt exists to pass reserved-profile selection.
  expect(allocate).not.toHaveBeenCalled(); expect(await f.store.load('s', target.attemptId)).toBeNull();
  expect(f.launch).not.toHaveBeenCalled();
  expect(await f.store.loadRun('s', 'r')).toMatchObject({ bindings: [{ identity: source }] });
  expect(await readAttemptHandoffEvents(f.store, target)).toBeNull();
});

it.for(['digest', 'sibling', 'old-attempt'] as const)('accepted chain refuses %s artifact substitution before dependent allocation or start receipt', async (mode, context) => {
  const f = await fixture(context), allocate = vi.spyOn(f.acquisition, 'acquire');
  const patch = mode === 'sibling' ? { ...f.prepared.patch, identity: { ...source, taskId: 'sibling', attemptId: 'c1' } }
    : mode === 'old-attempt' ? { ...f.prepared.patch, identity: { ...source, attemptId: 'a0' } } : f.prepared.patch;
  const bytes = Buffer.from(JSON.stringify(patch));
  const receipt = mode === 'digest' ? f.prepared.receipt : await f.artifacts.put('s', bytes);
  const original = f.store.loadBoundDispatch.bind(f.store);
  vi.spyOn(f.store, 'loadBoundDispatch').mockImplementation(async identity => {
    const record = await original(identity); return identity.attemptId === source.attemptId && record ? { ...record, patch: receipt } : record;
  });
  const port = { put: f.artifacts.put.bind(f.artifacts), async read(scope: string, requested: typeof receipt) {
    if (mode === 'digest' && requested.digest === receipt.digest) return Buffer.from(bytes.map(value => value ^ 1));
    return f.artifacts.read(scope, requested);
  } };
  await expect(f.start(port)).rejects.toMatchObject({ code: 'HANDOFF_ARTIFACT_MISMATCH' });
  expect(allocate).not.toHaveBeenCalled(); expect(await readAttemptHandoffEvents(f.store, target)).toBeNull();
  expect(f.launch).not.toHaveBeenCalled();
  expect(await f.store.loadBoundDispatch(target)).toBeNull();
});

it('valid G1 resolution cannot bless an incompatible dependent tree as G2 or persist a start receipt', async context => {
  const f = await fixture(context), starts = await f.resolve(), lease = await f.acquisition.acquire(target);
  await writeFile(join(lease.workspace, 'tracked'), 'foreign\n'); const before = await f.tree(lease);
  expect(starts[0]!.receipt).toEqual(f.prepared.receipt);
  await expect(f.start()).rejects.toMatchObject({ code: 'HANDOFF_PATCH_UNAPPLICABLE' });
  expect(await f.tree(lease)).toEqual(before); expect(await readAttemptHandoffEvents(f.store, target)).toBeNull();
  expect(f.launch).not.toHaveBeenCalled();
  expect(await f.store.loadBoundDispatch(target)).toBeNull();
});

it('a reserved dependent rechecks canonical source acceptance before any workspace or consumer effect', async context => {
  const f = await fixture(context), allocate = vi.spyOn(f.acquisition, 'acquire');
  const original = f.store.loadRun.bind(f.store);
  vi.spyOn(f.store, 'loadRun').mockImplementation(async (scope, runId) => {
    const run = await original(scope, runId);
    return run ? { ...run, progress: run.progress.map(task => task.taskId === source.taskId ? { ...task, phase: 'failed' as const } : task) } : run;
  });
  await expect(f.start()).rejects.toMatchObject({ code: 'HANDOFF_SOURCE_NOT_ACCEPTED' });
  expect(allocate).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
  expect(await readAttemptHandoffEvents(f.store, target)).toBeNull();
  expect((await original('s', 'r'))!.progress[0]!.phase).toBe('accepted'); // Fault injection never rewrites ledger history.
});
