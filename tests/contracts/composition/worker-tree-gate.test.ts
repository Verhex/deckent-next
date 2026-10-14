import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { DockerSupervisor, GitWorkspaceBroker, openSqliteAuditStore, readLocalOsIdentity } from '#adapters/index.js';
import { AuditApplication } from '#engine/index.js';
import { AuditError } from '#domain/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { advanceConfiguredRun } from '#composition/core/run-progression/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

// S6 (owner 2026-10-14): the pre-dispatch secret gate on the real execution path (Git clone, predecessor patches, Docker dispatch).
const exec = promisify(execFile), roots: string[] = [];
const dockerImage = process.env.DECKENT_TEST_DOCKER_IMAGE;
const dockerIt = it.skipIf(process.platform !== 'linux' || !dockerImage);
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const PROVIDER_TOKEN = ['sk', 'ant', 'api03', 'Qw7'.repeat(12)].join('-');

async function fixture(context: TestContext, files: Record<string, string>, secretGate?: object) {
  if (process.platform !== 'linux') context.skip('Docker execution and the private ledger are Linux-only here');
  const root = await mkdtemp(join(tmpdir(), 'worker-tree-gate-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const git = (...args: string[]) => exec('/usr/bin/git', ['-C', project, ...args]);
  await git('init', '-q'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  for (const [path, content] of Object.entries(files)) { await mkdir(join(project, path, '..'), { recursive: true }); await writeFile(join(project, path), content); }
  await git('add', '--', ...Object.keys(files)); await git('commit', '-q', '-m', 'base');
  const options = { env: { HOME: home, USERPROFILE: home } }, registry = fixtureDockerRegistry(['fixture']);
  const parameters = registry.profiles[0]!.parameters;
  if (dockerImage) Object.assign(parameters, { imageId: dockerImage, argv: ['node', '-e', "process.stdout.write(require('node:fs').readFileSync('/workspace/README.md','utf8'))"] });
  const { argv: _argv, ...docker } = parameters; void _argv;
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1,
    ordering: 'input-order', registry }, execution: { docker: { executable: '/usr/bin/docker', ...docker }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 },
    ...(secretGate ? { secretGate: { schemaVersion: 1, ...secretGate } } : {}) } }));
  const opened = await openConfiguredAttemptStore(project, options), store = opened.store;
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  const principal = { ...readLocalOsIdentity(), scopeIds: ['s'] }, principals = [{ issuer: principal.issuer, subject: principal.subject }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: [{ id: 'a', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
  const identity = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve', expectedRevision: 0 }, options)).reservation.identities[0]!;
  const auditPage = async () => {
    const audit = await openSqliteAuditStore(productResourcePath(opened.layout, 'ledger'), { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' });
    try { return audit.page('s', 0, 100).map(record => record.event.subject).filter(subject => subject.kind === 'worker-tree-refused'); } finally { audit.close(); }
  };
  return { project, options, store, identity, auditPage, workspaces: productResourcePath(opened.layout, 'workspaces') };
}
const COMMITTED_SECRETS = { 'README.md': '# project\n', '.env': 'DATABASE_URL=postgres://app@db/app\n', 'deploy/server.pem': '-----BEGIN PRIVATE KEY-----\n',
  'src/client.ts': `export const key = '${PROVIDER_TOKEN}';\n` };

it('refuses a committed .env, *.pem and a key-shaped string before any dispatch: typed refusal with paths, audit, no container, clone released', async context => {
  const f = await fixture(context, COMMITTED_SECRETS);
  try {
    const execute = vi.spyOn(DockerSupervisor.prototype, 'execute'), capture = vi.spyOn(DockerSupervisor.prototype, 'captureProfile');
    const allocate = vi.spyOn(GitWorkspaceBroker.prototype, 'allocate');
    const failure = await executeConfiguredTask(f.project, f.identity, f.options).catch((error: unknown) => error) as { code: string; message: string; params: Record<string, unknown> };
    expect(failure).toMatchObject({ code: 'WORKER_TREE_SECRET_REFUSED', params: { count: 3, omitted: 0,
      paths: '.env (deny-path:.env), deploy/server.pem (deny-path:**/*.pem), src/client.ts (pattern:provider-token)' } });
    expect(failure.message).toContain('src/client.ts'); expect(JSON.stringify(failure)).not.toContain(PROVIDER_TOKEN); expect(failure.message).not.toContain(PROVIDER_TOKEN);
    // The tree was prepared (the gate scans exactly what the worker would receive) but no container, profile capture or claim followed.
    expect(allocate).toHaveBeenCalledTimes(1); expect(capture).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(await f.store.loadBoundDispatch(f.identity)).toBeNull();
    expect(await readdir(f.workspaces)).toEqual([]);
    expect((await f.store.load('s', f.identity.attemptId))!.lastObservation?.result).toEqual({ kind: 'launch-refused', code: 'WORKER_TREE_SECRET_REFUSED' });
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'failed', unresolvedEffects: false });
    const subjects = await f.auditPage();
    expect(subjects).toEqual([{ kind: 'worker-tree-refused', runId: 'r', taskId: 'a', attemptId: f.identity.attemptId, code: 'WORKER_TREE_SECRET_REFUSED', count: 3, limit: null,
      findings: [{ path: '.env', rule: 'deny-path:.env' }, { path: 'deploy/server.pem', rule: 'deny-path:**/*.pem' }, { path: 'src/client.ts', rule: 'pattern:provider-token' }] }]);
    expect(JSON.stringify(subjects)).not.toContain(PROVIDER_TOKEN);
    // Permanent: the closed attempt is never started again and nothing is rewritten.
    await expect(executeConfiguredTask(f.project, f.identity, f.options)).rejects.toMatchObject({ code: 'RUN_STORE_CONFLICT' });
    expect(capture).not.toHaveBeenCalled(); expect(await f.auditPage()).toHaveLength(1);
  } finally { f.store.close(); }
});

it('run progression (the autonomous path) is refused the same way: one attempt, no container, task failed', async context => {
  const f = await fixture(context, COMMITTED_SECRETS);
  try {
    const capture = vi.spyOn(DockerSupervisor.prototype, 'captureProfile'), signal = new AbortController().signal, query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r' };
    const codes: string[] = [];
    for (let turn = 0; turn < 3; turn++) await advanceConfiguredRun(f.project, query, signal, f.options).catch((error: { code?: string }) => { codes.push(error.code ?? 'unknown'); });
    expect(codes).toEqual(['WORKER_TREE_SECRET_REFUSED']); expect(capture).not.toHaveBeenCalled(); expect(await readdir(f.workspaces)).toEqual([]);
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'failed' }); expect(await f.auditPage()).toHaveLength(1);
  } finally { f.store.close(); }
});

it('fails closed with its own reason when the scan cannot finish within its bounds', async context => {
  const f = await fixture(context, { 'README.md': '# project\n', 'data/dump.sql': 'x'.repeat(4096) }, { maxFileBytes: 1024 });
  try {
    const capture = vi.spyOn(DockerSupervisor.prototype, 'captureProfile');
    await expect(executeConfiguredTask(f.project, f.identity, f.options)).rejects.toMatchObject({ code: 'WORKER_TREE_SCAN_INCOMPLETE',
      params: { limit: 'maxFileBytes', observed: 4096, bound: 1024 } });
    expect(capture).not.toHaveBeenCalled(); expect(await readdir(f.workspaces)).toEqual([]);
    expect((await f.store.load('s', f.identity.attemptId))!.lastObservation?.result).toEqual({ kind: 'launch-refused', code: 'WORKER_TREE_SCAN_INCOMPLETE' });
    expect(await f.auditPage()).toMatchObject([{ kind: 'worker-tree-refused', code: 'WORKER_TREE_SCAN_INCOMPLETE', count: 0, findings: [], limit: 'file-bytes' }]);
  } finally { f.store.close(); }
});

it('no audit, no closure: an unrecordable refusal leaves the attempt open and undispatched, and the next turn records and closes it', async context => {
  const f = await fixture(context, COMMITTED_SECRETS);
  try {
    const capture = vi.spyOn(DockerSupervisor.prototype, 'captureProfile');
    const record = vi.spyOn(AuditApplication.prototype, 'record').mockImplementationOnce(() => { throw new AuditError('AUDIT_UNAVAILABLE'); });
    await expect(executeConfiguredTask(f.project, f.identity, f.options)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect((await f.store.load('s', f.identity.attemptId))!.lastObservation).toBeNull();
    expect(capture).not.toHaveBeenCalled(); expect(await readdir(f.workspaces)).toEqual([]); expect(await f.auditPage()).toEqual([]);
    await expect(executeConfiguredTask(f.project, f.identity, f.options)).rejects.toMatchObject({ code: 'WORKER_TREE_SECRET_REFUSED' });
    expect(record).toHaveBeenCalledTimes(2); expect(capture).not.toHaveBeenCalled(); expect(await f.auditPage()).toHaveLength(1);
    expect((await f.store.load('s', f.identity.attemptId))!.lastObservation?.result).toEqual({ kind: 'launch-refused', code: 'WORKER_TREE_SECRET_REFUSED' });
  } finally { f.store.close(); }
});

it('passes a tree whose only hits are acknowledged (fixture patterns, a settings-only .npmrc) on to the supervisor unchanged', async context => {
  const f = await fixture(context, { 'README.md': '# project\n', '.npmrc': 'engine-strict=true\n', 'tests/fixture.ts': `export const fake = '${PROVIDER_TOKEN}';\n` },
    { allowPatternPaths: ['tests/**'], acknowledgedDenyPaths: ['.npmrc'] });
  try {
    const capture = vi.spyOn(DockerSupervisor.prototype, 'captureProfile').mockRejectedValue(Object.assign(new Error('reached the supervisor'), { code: 'FIXTURE_REACHED' }));
    await expect(executeConfiguredTask(f.project, f.identity, f.options)).rejects.toBeTruthy();
    expect(capture).toHaveBeenCalledTimes(1); expect(await f.auditPage()).toEqual([]);
  } finally { f.store.close(); }
});

dockerIt('dispatches a clean project unchanged through a real container', async context => {
  const f = await fixture(context, { 'README.md': 'clean project\n', 'src/index.ts': 'export const answer = 42;\n' });
  try {
    const result = await executeConfiguredTask(f.project, f.identity, f.options);
    expect(result.execution).toMatchObject({ status: 'terminal', outputRecorded: true });
    expect((await f.store.loadBoundDispatch(f.identity))?.terminal).toMatchObject({ exitCode: 0 });
    expect(await f.auditPage()).toEqual([]);
  } finally { f.store.close(); }
}, 60_000);
