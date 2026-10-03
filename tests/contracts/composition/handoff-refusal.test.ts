import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { arch, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { FileArtifactStore, GitWorkspaceBroker, DockerSupervisor, readLocalOsIdentity } from '#adapters/index.js';
import { TaskEvaluationApplication, readAttemptHandoffEvents, recordHandoffRefusal, HandoffError } from '#engine/index.js';
import { clearConfigCache, prepareProductDirectory, productResourcePath } from '#platform/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(sourceTaskId: string, context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'handoff-refusal-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: home, USERPROFILE: home } }, registry = fixtureDockerRegistry(['fixture']);
  const { argv: _argv, ...docker } = registry.profiles[0]!.parameters; void _argv;
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p',
    executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry }, execution: { docker: { executable: '/usr/bin/docker', ...docker },
    git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  if (process.platform === 'win32') {
    await expect(openConfiguredAttemptStore(project, options)).rejects.toMatchObject({ code: 'MANAGED_FILE_UNSUPPORTED' });
    await expect(stat(data)).rejects.toMatchObject({ code: 'ENOENT' });
    context.skip('MANAGED_FILE_UNSUPPORTED: configured refusal receipt requires POSIX private ledger; real storage refusal verified before effects');
  }
  const opened = await openConfiguredAttemptStore(project, options), store = opened.store;
  try {
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
    const principal = { ...readLocalOsIdentity(), scopeIds: ['s'] }, actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    const principals = [{ issuer: principal.issuer, subject: principal.subject }];
    await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', restrictions: [], grants: [
      { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
      { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
      { id: 'attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
    ] }), { mode: 0o600 });
    const graph = { schemaVersion: 4 as const, revision: 1, tasks: [
      { id: sourceTaskId, kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] },
      { id: 'b', kind: 'fixture', dependencies: [sourceTaskId], acceptanceCriteria: ['exit'] },
      { id: 'c', kind: 'fixture', dependencies: ['b'], acceptanceCriteria: ['exit'] },
    ], criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
    await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
    const source = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve-source', expectedRevision: 0 }, options)).reservation.identities[0]!;
    const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 65536 });
    const note = { toTask: 'b', summary: 'Use accepted result', artifacts: [], openQuestions: [] };
    const output = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity: source, completeness: 'complete', stdout: JSON.stringify({ schemaVersion: 1,
      kind: 'native-worker-report', status: 'reported', report: { schemaVersion: 1, summary: 'done', changedFiles: [], checks: [], openIssues: [], handoff: note, sharedNotes: ['shared'] } }), stderr: '' })));
    const os = userInfo(), workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces');
    // Retained, validated fixture evidence; no Docker process, Git checkout or provider is started.
    const claim = { owner: principal.id, request: { protocolVersion: 1 as const, identity: source, workspace: project, argv: ['node', 'task.js'] } };
    await store.claimDispatch({ ...claim, profile: { schemaVersion: 1, adapterId: 'docker', adapterVersion: 2, parameters: {
      endpoint: 'unix:///fixture.sock', options: { ...docker, executable: '/usr/bin/docker', workspaceRoot, uid: os.uid, gid: os.gid },
      origin: { hostname: hostname(), platform: process.platform, architecture: arch(), uid: os.uid, gid: os.gid, daemonId: 'fixture' },
    } } });
    await store.grantLaunch({ claim, principal, now: 1 });
    await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: 'fixture', exitCode: 0, interrupted: false });
    const evaluation = await new TaskEvaluationApplication(store, { async verify() { return principal; } }, { async authorize() {} }, { async evaluate() { return 'pass'; } },
      artifacts, { maxEvidenceItems: 1, maxTotalBytes: 65536 }, { now: Date.now, timeoutMs: 1000 }).execute({ schemaVersion: 1, commandId: 'evaluate', identity: source, expectedRevision: 2 });
    expect(evaluation.snapshot.progress[0]).toMatchObject({ taskId: sourceTaskId, phase: 'accepted' });
    expect(JSON.parse(evaluation.command).evaluation.handoff.status).toBe('valid');
    const target = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve-target', expectedRevision: evaluation.snapshot.revision }, options)).reservation.identities[0]!;
    return { project, options, opened, target, actor, workspaceRoot };
  } catch (error) { store.close(); throw error; }
}
it.for(['src\ud800', 'src\udc00'])('configured start refuses accepted UTF-16 source %j with immutable receipt and dependent park', async (sourceTaskId, context) => {
  const f = await fixture(sourceTaskId, context), store = f.opened.store;
  try {
    const put = vi.spyOn(FileArtifactStore.prototype, 'put'), allocate = vi.spyOn(GitWorkspaceBroker.prototype, 'allocate'), worker = vi.spyOn(DockerSupervisor.prototype, 'execute');
    const commandId = 'handoff-refused-' + createHash('sha256').update(JSON.stringify(f.target)).digest('hex');
    await expect(executeConfiguredTask(f.project, f.target, f.options)).rejects.toMatchObject({ code: 'HANDOFF_INVALID' });
    expect(put).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled(); expect(worker).not.toHaveBeenCalled();
    expect(await readdir(f.workspaceRoot)).toEqual([]); expect(await store.loadBoundDispatch(f.target)).toBeNull();
    expect(await readAttemptHandoffEvents(store, f.target)).toBeNull();
    const receipt = await store.receipt('s', commandId), run = await store.loadRun('s', 'r');
    expect(receipt).toMatchObject({ snapshot: { lastObservation: { result: { kind: 'handoff-refused', code: 'HANDOFF_INVALID' } } } });
    expect(run!.progress.map(task => task.phase)).toEqual(['accepted', 'failed', 'skipped']); expect(run!.state.kind).toBe('parked');
    // Replay the existing refusal owner and then the public start: terminal selection refuses; neither rewrites history.
    await recordHandoffRefusal(store, f.target, new HandoffError('HANDOFF_INVALID'), f.actor);
    await expect(executeConfiguredTask(f.project, f.target, f.options)).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
    expect(await store.receipt('s', commandId)).toEqual(receipt); expect(await store.loadRun('s', 'r')).toEqual(run);
    expect(await store.loadBoundDispatch(f.target)).toBeNull();
    const reopened = await openConfiguredAttemptStore(f.project, f.options);
    try {
      await recordHandoffRefusal(reopened.store, f.target, new HandoffError('HANDOFF_INVALID'), f.actor);
      expect(await reopened.store.receipt('s', commandId)).toEqual(receipt);
      expect(await reopened.store.loadRun('s', 'r')).toEqual(run);
      expect(await reopened.store.loadBoundDispatch(f.target)).toBeNull();
    } finally { reopened.store.close(); }
  } finally { store.close(); }
});
