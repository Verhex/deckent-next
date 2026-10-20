import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { DockerSupervisor, readLocalOsIdentity } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { applyConfiguredRunLifecycle, createConfiguredRun, deliverConfiguredRunCancellation, inspectConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { inspectMonitor } from '#composition/core/monitor/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { runCommand } from '#surfaces/core/cli/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { advanceConfiguredRun } from '#composition/core/run-progression/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

// PRE-7 ORTAM-HAZIR on the real execution path (Git clone, secret gate, Docker): Deckent checks the task's declared environment before any
// worker starts. Unmet: no worker, no connection, the Run parks naming the requirement; fixed + resumed: a new attempt is checked again and launches.
const exec = promisify(execFile), roots: string[] = [];
const dockerImage = process.env.DECKENT_TEST_DOCKER_IMAGE;
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const REQUIREMENTS = { schemaVersion: 1, requirements: [{ id: 'node', kind: 'executable', target: 'node' }, { id: 'marker', kind: 'path-readable', target: '/deps/marker.txt' }] };
/** This test's probe containers (by the worker handle they derive from); other files' probes may run in parallel. */
const preflightContainers = async (probe: { mock: { contexts: unknown[]; calls: unknown[][] } }) => {
  const handles = await Promise.all(probe.mock.calls.map((call, index) => (probe.mock.contexts[index] as DockerSupervisor).inspectActivity(call[0] as never).then(value => value.handle)));
  return (await Promise.all(handles.map(async handle => (await exec('/usr/bin/docker', ['ps', '-aq', '--filter', `name=${handle}-env-`])).stdout.trim()))).join('');
};

async function fixture(context: TestContext, environment: object) {
  if (process.platform !== 'linux' || !dockerImage) context.skip('Docker execution and the private ledger are Linux-only here; needs DECKENT_TEST_DOCKER_IMAGE');
  const root = await mkdtemp(join(tmpdir(), 'environment-preflight-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(join(project, 'deps'));
  const git = (...args: string[]) => exec('/usr/bin/git', ['-C', project, ...args]);
  await git('init', '-q'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'README.md'), '# project\n'); await git('add', 'README.md'); await git('commit', '-q', '-m', 'base');
  await writeFile(join(project, 'deps/other.txt'), 'present\n');
  const options = { env: { HOME: home, USERPROFILE: home } }, registry = fixtureDockerRegistry(['fixture']);
  const parameters = registry.profiles[0]!.parameters;
  Object.assign(parameters, { imageId: dockerImage, argv: ['node', '-e', "process.stdout.write(require('node:fs').readFileSync('/workspace/README.md','utf8'))"] });
  const { argv: _argv, ...docker } = parameters; void _argv;
  Object.assign(parameters, { readOnlyMounts: [{ source: 'deps', target: '/deps' }], environment });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, cancellation: { maxAttempts: 3, retryDelayMs: 100, claimTtlMs: 1000, maxConcurrentDeliveries: 1, recoveryPageSize: 10 }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1,
    ordering: 'input-order', registry }, execution: { docker: { executable: '/usr/bin/docker', ...docker }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const opened = await openConfiguredAttemptStore(project, options), store = opened.store;
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  const principal = { ...readLocalOsIdentity(), scopeIds: ['s'] }, principals = [{ issuer: principal.issuer, subject: principal.subject }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect', 'cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'resume', effect: 'allow', actions: ['resume'], scopes: ['s'], principals, resource: { kind: 'run-decision', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'monitor', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: [{ id: 'a', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
  return { project, options, store, workspaces: productResourcePath(opened.layout, 'workspaces') };
}
const reserve = async (f: Awaited<ReturnType<typeof fixture>>, revision: number, commandId = 'reserve') =>
  (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId, expectedRevision: revision }, f.options)).reservation.identities[0]!;

it('an unmet declared requirement parks the Run naming it before any worker: no launch, checkout released, operator told it is an installation defect', async context => {
  const f = await fixture(context, REQUIREMENTS);
  try {
    const execute = vi.spyOn(DockerSupervisor.prototype, 'execute'), probe = vi.spyOn(DockerSupervisor.prototype, 'probe');
    const identity = await reserve(f, 0);
    const failure = await executeConfiguredTask(f.project, identity, f.options).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'EXECUTION_ENVIRONMENT_NOT_READY', params: { requirement: 'marker', kind: 'path-readable', target: '/deps/marker.txt', registered: 'yes' } });
    // Both probes ran in declaration order on the worker's floor; neither the worker nor its connection started.
    expect(probe.mock.calls.map(call => call[1])).toEqual([['node', '--version'], ['node', '-e', expect.stringContaining('accessSync'), '/deps/marker.txt']]);
    expect(execute).not.toHaveBeenCalled(); expect(await f.store.loadBoundDispatch(identity)).toBeNull();
    expect(await readdir(f.workspaces)).toEqual([]); expect(await preflightContainers(probe)).toBe('');
    expect((await f.store.load('s', identity.attemptId))!.lastObservation?.result).toEqual({ kind: 'launch-refused', code: 'EXECUTION_ENVIRONMENT_NOT_READY', requirement: 'marker' });
    const run = (await f.store.loadRun('s', 'r'))!;
    expect(run.state).toMatchObject({ kind: 'parked', reason: 'environment-not-ready', failureCode: 'marker' });
    expect(run.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: false }); expect(run.progress[0]!.notAcceptedReason).toBeUndefined();
    // No blind retry: progression turns while parked start nothing.
    for (let turn = 0; turn < 3; turn++) expect((await advanceConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, new AbortController().signal, f.options)).attempted).toBe(0);
    expect(probe).toHaveBeenCalledTimes(2);
    for (const [locale, words] of [['en', 'Environment not ready: marker'], ['tr', 'Ortam hazır değil: marker']] as const) {
      const output: string[] = [];
      await runCommand(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], { root: f.project, env: f.options.env, stdout: { write(text: string) { output.push(text); } }, inspectRun: inspectConfiguredRun });
      expect(output.join('')).toContain(words); expect(output.join('')).toContain('deckent run resume');
    }
    const monitor = (await loadMonitorSurface()).buildMonitorView(await inspectMonitor(f.project, f.options), 'en', true).tabs.runs
      .flatMap(block => block.kind === 'table' ? block.rows : []).flatMap(row => [row.cells.map(cell => cell.text).join(' '), ...row.detail().map(line => line.map(item => item.text).join(''))]).join('\n');
    expect(monitor).toContain('environment not ready: marker');
    // The --once summary renders the same words (one detail renderer), never the raw machine detail.
    // Phase 2 (lead, brief §1): the park line says in words it is an installation problem, not a worker or task failure.
    for (const [locale, words, kind] of [['en', 'environment not ready: marker', 'an installation problem, not a task failure'], ['tr', 'ortam hazır değil: marker', 'kurulum sorunu, görev hatası değil']] as const) {
      const once = (await loadMonitorSurface()).renderMonitorText(await inspectMonitor(f.project, f.options), { locale, width: 240, ascii: true });
      expect(once).toContain(words); expect(once).toContain(kind); expect(once).not.toContain('environment-not-ready:marker');
    }
  } finally { f.store.close(); }
}, 120_000);

it('after the operator fixes the environment and resumes, a new attempt is checked again and the worker launches; a fit environment proceeds directly', async context => {
  const f = await fixture(context, REQUIREMENTS);
  try {
    const first = await reserve(f, 0);
    await expect(executeConfiguredTask(f.project, first, f.options)).rejects.toMatchObject({ code: 'EXECUTION_ENVIRONMENT_NOT_READY' });
    await writeFile(join(f.project, 'deps/marker.txt'), 'fixed\n');
    const parked = (await f.store.loadRun('s', 'r'))!;
    await applyConfiguredRunLifecycle(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'resume', action: 'resume', expectedRevision: parked.revision }, f.options);
    const probe = vi.spyOn(DockerSupervisor.prototype, 'probe'), execute = vi.spyOn(DockerSupervisor.prototype, 'execute');
    const second = await reserve(f, (await f.store.loadRun('s', 'r'))!.revision, 'reserve-2');
    expect(second.generation).toBe(2); expect(second.attemptId).not.toBe(first.attemptId);
    const result = await executeConfiguredTask(f.project, second, f.options);
    expect(result.execution).toMatchObject({ terminal: { exitCode: 0 } });
    expect(probe).toHaveBeenCalledTimes(2); expect(execute).toHaveBeenCalledTimes(1);
    const run = (await f.store.loadRun('s', 'r'))!;
    expect(run.previousBindings).toEqual([expect.objectContaining({ identity: first, observedKind: 'launch-refused' })]);
    expect(run.bindings).toEqual([expect.objectContaining({ identity: second, observedKind: 'exited' })]);
    expect(await preflightContainers(probe)).toBe('');
  } finally { f.store.close(); }
}, 120_000);

it('cancelling an environment-parked Run through the real delivery path ends it cancelled; the refused attempt needs no worker settlement', async context => {
  const f = await fixture(context, REQUIREMENTS);
  try {
    await expect(executeConfiguredTask(f.project, await reserve(f, 0), f.options)).rejects.toMatchObject({ code: 'EXECUTION_ENVIRONMENT_NOT_READY' });
    const parked = (await f.store.loadRun('s', 'r'))!;
    await deliverConfiguredRunCancellation(f.project, { schemaVersion: 1, action: 'cancel', commandId: 'cancel', scopeId: 's', runId: 'r', expectedRevision: parked.revision }, f.options);
    const run = (await f.store.loadRun('s', 'r'))!;
    expect(run.state).toEqual({ kind: 'terminal', outcome: 'cancelled', reason: 'cancelled' }); expect(run.progress[0]!.phase).toBe('cancelled');
  } finally { f.store.close(); }
}, 120_000);

it('negative: a requirement whose probe kind no adapter registers refuses (fail closed); no declaration runs no probe at all', async context => {
  const f = await fixture(context, { schemaVersion: 1, requirements: [{ id: 'erp', kind: 'connector-reachable', target: 'erp-main' }] });
  try {
    const probe = vi.spyOn(DockerSupervisor.prototype, 'probe');
    await expect(executeConfiguredTask(f.project, await reserve(f, 0), f.options)).rejects.toMatchObject({ code: 'EXECUTION_ENVIRONMENT_NOT_READY', params: { requirement: 'erp', registered: 'no' } });
    expect(probe).not.toHaveBeenCalled();
  } finally { f.store.close(); }
  const plain = await fixture(context, undefined as unknown as object);
  try {
    const probe = vi.spyOn(DockerSupervisor.prototype, 'probe');
    expect((await executeConfiguredTask(plain.project, await reserve(plain, 0), plain.options)).execution).toMatchObject({ terminal: { exitCode: 0 } });
    expect(probe).not.toHaveBeenCalled();
  } finally { plain.store.close(); }
}, 120_000);
