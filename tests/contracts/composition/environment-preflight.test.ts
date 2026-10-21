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
import { executeConfiguredTask, releaseConfiguredPreflightProbes, settleConfiguredEnvironmentProbes } from '#composition/core/execution/index.js';
import { advanceConfiguredRun } from '#composition/core/run-progression/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

// PRE-7 ORTAM-HAZIR on the real execution path (Git clone, secret gate, Docker): Deckent checks the task's declared environment before any
// worker starts. Unmet: no worker, no connection, the Run parks naming the requirement; fixed + resumed: a new attempt is checked again and launches.
const exec = promisify(execFile), roots: string[] = [];
const dockerImage = process.env.DECKENT_TEST_DOCKER_IMAGE;
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const PROBE = 'deckent-env-' + 'a'.repeat(64);
const REQUIREMENTS = { schemaVersion: 1, requirements: [{ id: 'node', kind: 'executable', target: 'node' }, { id: 'marker', kind: 'path-readable', target: '/deps/marker.txt' }] };
/** This test's probe containers (by the worker handle they derive from); other files' probes may run in parallel. */
const preflightContainers = async (probe: { mock: { contexts: unknown[]; calls: unknown[][] } }) => {
  const handles = await Promise.all(probe.mock.calls.map((call, index) => (probe.mock.contexts[index] as DockerSupervisor).inspectActivity(call[0] as never).then(value => value.handle)));
  return (await Promise.all(handles.map(async handle => (await exec('/usr/bin/docker', ['ps', '-aq', '--filter', `name=${handle}-env-`])).stdout.trim()))).join('');
};

async function fixture(context: TestContext, environment: object, slots = 1) {
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
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, cancellation: { maxAttempts: 3, retryDelayMs: 100, claimTtlMs: 1000, maxConcurrentDeliveries: 1, recoveryPageSize: 10 }, admission: { poolId: 'p', executionSlots: slots, inFlightSlots: slots,
    ordering: 'input-order', registry }, execution: { docker: { executable: '/usr/bin/docker', ...docker }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const opened = await openConfiguredAttemptStore(project, options), store = opened.store;
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: slots, inFlightSlots: slots } });
  const principal = { ...readLocalOsIdentity(), scopeIds: ['s'] }, principals = [{ issuer: principal.issuer, subject: principal.subject }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect', 'cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'resume', effect: 'allow', actions: ['resume'], scopes: ['s'], principals, resource: { kind: 'run-decision', ids: 'all' } },
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

it('REVISE 2691: a probe whose end cannot be proven is uncertain: nothing launches, the refusal is typed as uncertain with its requirement, the Run parks for the operator', async context => {
  const f = await fixture(context, REQUIREMENTS);
  try {
    const execute = vi.spyOn(DockerSupervisor.prototype, 'execute'), probe = vi.spyOn(DockerSupervisor.prototype, 'probe').mockResolvedValueOnce({ uncertain: PROBE });
    const identity = await reserve(f, 0);
    await expect(executeConfiguredTask(f.project, identity, f.options)).rejects.toMatchObject({ code: 'EXECUTION_ENVIRONMENT_UNCERTAIN', params: { requirement: 'node', probe: PROBE } });
    expect(probe).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled(); expect(await readdir(f.workspaces)).toEqual([]);
    expect((await f.store.load('s', identity.attemptId))!.lastObservation?.result).toEqual({ kind: 'launch-refused', code: 'EXECUTION_ENVIRONMENT_UNCERTAIN', requirement: 'node', probe: PROBE });
    expect((await f.store.loadRun('s', 'r'))!.state).toMatchObject({ kind: 'parked', reason: 'environment-not-ready', failureCode: 'node' });
    // Turns while parked start nothing, so no second probe of that identity is started behind the operator's back.
    expect((await advanceConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, new AbortController().signal, f.options)).attempted).toBe(0); expect(probe).toHaveBeenCalledTimes(1);
  } finally { f.store.close(); }
}, 120_000);

it('REVISE 2693: an uncertain probe keeps its pool slot (capacity 1): another Run cannot reserve, cancel and restart-time unproven checks release nothing, the proven removal releases it exactly once', async context => {
  const f = await fixture(context, REQUIREMENTS);
  try {
    const graph = { schemaVersion: 4 as const, revision: 1, tasks: [{ id: 'b', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] }],
      criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
    await createConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r2', commandId: 'create-r2', graph }, f.options);
    vi.spyOn(DockerSupervisor.prototype, 'probe').mockResolvedValueOnce({ uncertain: PROBE });
    await expect(executeConfiguredTask(f.project, await reserve(f, 0), f.options)).rejects.toMatchObject({ code: 'EXECUTION_ENVIRONMENT_UNCERTAIN' });
    const reserveB = () => reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r2', commandId: 'reserve-r2-' + Math.random(), expectedRevision: 0 }, f.options);
    await expect(reserveB()).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
    // Cancel of A while uncertain: no silent release.
    await deliverConfiguredRunCancellation(f.project, { schemaVersion: 1, action: 'cancel', commandId: 'cancel', scopeId: 's', runId: 'r', expectedRevision: (await f.store.loadRun('s', 'r'))!.revision }, f.options);
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: true }); await expect(reserveB()).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
    // A start (or a turn) that cannot prove the probe gone releases nothing and reports it as held.
    const remove = vi.spyOn(DockerSupervisor, 'removePreflightProbe').mockResolvedValue(false);
    expect(await releaseConfiguredPreflightProbes(f.project, f.options)).toMatchObject({ released: 0, held: [PROBE] });
    expect(await settleConfiguredEnvironmentProbes(f.project, { scopeId: 's', runId: 'r' }, f.options)).toEqual({ released: 0, held: [PROBE] });
    await expect(reserveB()).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
    // Proven removed (real Docker: that container does not exist): released exactly once; the cancelled Run ends; B reserves.
    remove.mockRestore();
    expect(await settleConfiguredEnvironmentProbes(f.project, { scopeId: 's', runId: 'r' }, f.options)).toEqual({ released: 1, held: [] });
    expect(await settleConfiguredEnvironmentProbes(f.project, { scopeId: 's', runId: 'r' }, f.options)).toEqual({ released: 0, held: [] });
    expect((await f.store.loadRun('s', 'r'))!.state).toMatchObject({ kind: 'terminal', reason: 'cancelled' });
    await expect(reserveB()).resolves.toBeTruthy();
  } finally { f.store.close(); }
}, 120_000);

// REVISE 2695 (Astra REVIEW2694 F1): custody is durable before the first probe container starts. A cancel while the probe runs releases
// nothing; only the end of the probe path (an answer, or the proven removal of every probe it covers) does, exactly once.
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const secondRun = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: [{ id: 'b', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r2', commandId: 'create-r2', graph }, f.options);
  return () => reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r2', commandId: 'reserve-r2-' + Math.random(), expectedRevision: 0 }, f.options);
};
const cancelA = async (f: Awaited<ReturnType<typeof fixture>>) => deliverConfiguredRunCancellation(f.project,
  { schemaVersion: 1, action: 'cancel', commandId: 'cancel-' + Math.random(), scopeId: 's', runId: 'r', expectedRevision: (await f.store.loadRun('s', 'r'))!.revision }, f.options);
/** The real probe runs (its container proven gone), then the answer waits for the gate: the controller is still inside the probe path. */
const pausedProbe = (gate: Promise<void>, started: () => void) => {
  const original = DockerSupervisor.prototype.probe;
  return vi.spyOn(DockerSupervisor.prototype, 'probe').mockImplementationOnce(async function (this: DockerSupervisor, ...args: Parameters<DockerSupervisor['probe']>) {
    const answer = await original.apply(this, args); started(); await gate; return answer;
  });
};

it('REVISE 2695: A cancelled while its probe container runs keeps the slot (capacity 1): B is refused; the uncertain end holds A discoverably; the proven removal releases it once', async context => {
  const f = await fixture(context, REQUIREMENTS), gate = deferred(), started = deferred(); let name = '', running: Promise<unknown> | undefined;
  try {
    const reserveB = await secondRun(f), execute = vi.spyOn(DockerSupervisor.prototype, 'execute');
    // A's probe container is really running (same deterministic name and installation label) when the cancel arrives, and it is left running.
    vi.spyOn(DockerSupervisor.prototype, 'probe').mockImplementationOnce(async function (this: DockerSupervisor, request, argv) {
      const identity = this.probeIdentity(request, argv); name = identity.name;
      await exec('/usr/bin/docker', ['run', '-d', '--name', name, '--label', 'deckent.preflight.root=' + identity.root, '--network', 'none', '--entrypoint', 'node', dockerImage!, '-e', 'setTimeout(() => {}, 600000)']);
      started.resolve(); await gate.promise; return { uncertain: name };
    });
    const identity = await reserve(f, 0);
    running = executeConfiguredTask(f.project, identity, f.options).catch((error: unknown) => error);
    await started.promise;
    await cancelA(f);
    await expect(reserveB()).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'active', unresolvedEffects: true });
    gate.resolve();
    expect(await running).toMatchObject({ code: 'EXECUTION_ENVIRONMENT_UNCERTAIN', params: { requirement: 'node', probe: name } });
    expect(execute).not.toHaveBeenCalled(); expect(await f.store.loadBoundDispatch(identity)).toBeNull();
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: true });
    await expect(reserveB()).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
    // Discoverable: a check that cannot prove the removal holds it; the proven removal (the live container really removed) releases it once.
    const remove = vi.spyOn(DockerSupervisor, 'removePreflightProbe').mockResolvedValue(false);
    expect(await settleConfiguredEnvironmentProbes(f.project, { scopeId: 's', runId: 'r' }, f.options)).toEqual({ released: 0, held: [name] });
    remove.mockRestore();
    expect(await settleConfiguredEnvironmentProbes(f.project, { scopeId: 's', runId: 'r' }, f.options)).toEqual({ released: 1, held: [] });
    expect(await settleConfiguredEnvironmentProbes(f.project, { scopeId: 's', runId: 'r' }, f.options)).toEqual({ released: 0, held: [] });
    expect((await exec('/usr/bin/docker', ['ps', '-aq', '--filter', 'name=^' + name + '$'])).stdout.trim()).toBe('');
    expect((await f.store.loadRun('s', 'r'))!.state).toMatchObject({ kind: 'terminal', reason: 'cancelled' });
    await expect(reserveB()).resolves.toBeTruthy();
  } finally { gate.resolve(); await running; f.store.close(); if (name) await exec('/usr/bin/docker', ['rm', '--force', name]).catch(() => undefined); }
}, 120_000);

it('REVISE 2695: A cancelled during a probe that then meets ends cancelled: no handoff, no dispatch claim, checkout released, the slot opens once and B reserves', async context => {
  const f = await fixture(context, REQUIREMENTS), gate = deferred(), started = deferred(); let running: Promise<unknown> | undefined;
  try {
    await writeFile(join(f.project, 'deps/marker.txt'), 'present\n');
    const reserveB = await secondRun(f), execute = vi.spyOn(DockerSupervisor.prototype, 'execute'), probe = pausedProbe(gate.promise, started.resolve);
    const identity = await reserve(f, 0);
    running = executeConfiguredTask(f.project, identity, f.options);
    await started.promise;
    await cancelA(f);
    await expect(reserveB()).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
    gate.resolve();
    expect((await running as Awaited<ReturnType<typeof executeConfiguredTask>>).execution).toMatchObject({ status: 'prevented' });
    expect(probe).toHaveBeenCalledTimes(2); expect(execute).not.toHaveBeenCalled(); expect(await f.store.loadBoundDispatch(identity)).toBeNull();
    expect(await readdir(f.workspaces)).toEqual([]); expect(await preflightContainers(probe)).toBe('');
    const run = (await f.store.loadRun('s', 'r'))!;
    expect(run.progress[0]).toMatchObject({ phase: 'cancelled', unresolvedEffects: false }); expect(run.state).toMatchObject({ kind: 'terminal', reason: 'cancelled' });
    await expect(reserveB()).resolves.toBeTruthy();
  } finally { gate.resolve(); await running?.catch(() => undefined); f.store.close(); }
}, 120_000);

it('REVISE 2695: a controller gone mid-probe leaves its custody: a turn never touches it, a start that cannot prove removal keeps it, the proven start releases it once', async context => {
  const f = await fixture(context, { schemaVersion: 1, requirements: [REQUIREMENTS.requirements[0]] }), gate = deferred(), started = deferred(); let running: Promise<unknown> | undefined;
  try {
    const reserveB = await secondRun(f), execute = vi.spyOn(DockerSupervisor.prototype, 'execute');
    pausedProbe(gate.promise, started.resolve);
    const identity = await reserve(f, 0);
    running = executeConfiguredTask(f.project, identity, f.options).catch((error: unknown) => error);
    await started.promise;
    const names = (await f.store.loadRun('s', 'r'))!.bindings[0]!.probes!;
    expect(names).toHaveLength(1); for (const value of names) expect(value).toMatch(/^deckent-env-[a-f0-9]{64}$/);
    // A turn of this Run while its controller may still be probing: the custody is not reconciled and nothing starts.
    expect(await settleConfiguredEnvironmentProbes(f.project, { scopeId: 's', runId: 'r' }, f.options)).toEqual({ released: 0, held: [] });
    expect((await advanceConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, new AbortController().signal, f.options)).attempted).toBe(0);
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'active', unresolvedEffects: true });
    await cancelA(f); await expect(reserveB()).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
    // Service start (the controller is treated as gone): an unproven removal keeps the hold; the proven one releases it exactly once.
    const remove = vi.spyOn(DockerSupervisor, 'removePreflightProbe').mockResolvedValue(false);
    expect(await releaseConfiguredPreflightProbes(f.project, f.options)).toMatchObject({ released: 0, held: names });
    await expect(reserveB()).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
    remove.mockRestore();
    expect(await releaseConfiguredPreflightProbes(f.project, f.options)).toMatchObject({ released: 1, held: [] });
    expect(await releaseConfiguredPreflightProbes(f.project, f.options)).toMatchObject({ released: 0, held: [] });
    const run = (await f.store.loadRun('s', 'r'))!;
    expect(run.progress[0]).toMatchObject({ phase: 'cancelled', unresolvedEffects: false }); expect(run.state).toMatchObject({ kind: 'terminal', reason: 'cancelled' });
    await expect(reserveB()).resolves.toBeTruthy();
    // The stale controller's later answer finds no custody: it neither hands off nor claims a dispatch.
    gate.resolve(); expect(await running).toMatchObject({ code: 'RUN_STORE_CONFLICT' });
    expect(execute).not.toHaveBeenCalled(); expect(await f.store.loadBoundDispatch(identity)).toBeNull();
  } finally { gate.resolve(); await running; f.store.close(); }
}, 120_000);

it('REVISE 2695: a probe failure that is not an answer is never "gone" by itself: unproven removal → the uncertain hold; proven → the custody clears and the failure stays transient', async context => {
  const f = await fixture(context, REQUIREMENTS);
  try {
    const remove = vi.spyOn(DockerSupervisor, 'removePreflightProbe').mockResolvedValueOnce(false);
    vi.spyOn(DockerSupervisor.prototype, 'probe').mockRejectedValueOnce(new Error('daemon gone')).mockRejectedValueOnce(new Error('daemon gone'));
    const identity = await reserve(f, 0);
    const held = await executeConfiguredTask(f.project, identity, f.options).catch((error: unknown) => error) as { code: string; params: { probe: string } };
    expect(held).toMatchObject({ code: 'EXECUTION_ENVIRONMENT_UNCERTAIN', params: { requirement: 'node', probe: expect.stringMatching(/^deckent-env-[a-f0-9]{64}$/) } });
    expect(remove).toHaveBeenCalledWith(expect.anything(), held.params.probe);
    expect((await f.store.loadRun('s', 'r'))!.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: true });
    // A fresh Run's attempt whose failing probe is proven removed: the failure propagates unclassified and the custody is cleared, not held.
    const other = await fixture(context, REQUIREMENTS);
    try {
      const second = await reserve(other, 0);
      await expect(executeConfiguredTask(other.project, second, other.options)).rejects.toMatchObject({ code: 'QUERY_UNEXPECTED_FAILURE' });
      const run = (await other.store.loadRun('s', 'r'))!;
      expect(run.progress[0]).toMatchObject({ phase: 'active', unresolvedEffects: false }); expect(run.bindings[0]).not.toHaveProperty('probes');
      expect((await other.store.load('s', second.attemptId))!.lastObservation).toBeNull();
    } finally { other.store.close(); }
  } finally { f.store.close(); }
}, 120_000);

// REVISE 2698 (Astra REVIEW2697 F1): several holds of one Run settle in ONE pass, each against the Run's current revision with its exact
// identity and probe set re-checked in the transaction; one unproven (or conflicting) hold never stops the others or a later Run.
const multiRun = async (f: Awaited<ReturnType<typeof fixture>>, runId: string, tasks: readonly string[]) => {
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: tasks.map(id => ({ id, kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] })),
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId, commandId: 'create-' + runId, graph }, f.options);
  return (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId, commandId: 'reserve-' + runId, expectedRevision: 0 }, f.options)).reservation.identities;
};
const probeName = (seed: string) => 'deckent-env-' + seed.repeat(64).slice(0, 64);

it('REVISE 2698: several custody holds of one Run (and a later Run) are all released in one start; an unproven one stays held while the others are released; replays release nothing twice', async context => {
  const f = await fixture(context, REQUIREMENTS, 4);
  try {
    const [x, y, z] = await multiRun(f, 'm', ['x', 'y', 'z']), [w] = await multiRun(f, 'n', ['w']);
    expect([x, y, z, w].every(Boolean)).toBe(true);
    const names = new Map([[x!, probeName('1')], [y!, probeName('2')], [z!, probeName('3')], [w!, probeName('4')]]);
    // A controller creates the workspaces directory before it writes custody (task.ts); here custody is written directly.
    await mkdir(f.workspaces, { recursive: true });
    const hold = async () => { for (const [identity, name] of names) await f.store.holdEnvironmentProbes(identity, [name]); };
    const tasks = async (runId: string) => (await f.store.loadRun('s', runId))!.progress.map(task => [task.taskId, task.phase, task.unresolvedEffects]);
    // Controllers gone with four probes in flight (three in one Run): one start proves every name removed and releases all four, once.
    await hold();
    expect(await releaseConfiguredPreflightProbes(f.project, f.options)).toMatchObject({ released: 4, held: [] });
    expect(await releaseConfiguredPreflightProbes(f.project, f.options)).toMatchObject({ released: 0, held: [] });
    expect([...await tasks('m'), ...await tasks('n')]).toEqual([['x', 'active', false], ['y', 'active', false], ['z', 'active', false], ['w', 'active', false]]);
    // Again, with y's removal unproven: x and z (same Run, before and after y) and w (later Run) are released; y alone stays held.
    await hold();
    const original = DockerSupervisor.removePreflightProbe;
    vi.spyOn(DockerSupervisor, 'removePreflightProbe').mockImplementation((settings, name, runner) => name === names.get(y!) ? Promise.resolve(false) : original(settings, name, runner));
    expect(await releaseConfiguredPreflightProbes(f.project, f.options)).toMatchObject({ released: 3, held: [names.get(y!)] });
    expect([...await tasks('m'), ...await tasks('n')]).toEqual([['x', 'active', false], ['y', 'active', true], ['z', 'active', false], ['w', 'active', false]]);
    vi.mocked(DockerSupervisor.removePreflightProbe).mockRestore();
    expect(await releaseConfiguredPreflightProbes(f.project, f.options)).toMatchObject({ released: 1, held: [] });
    expect(await releaseConfiguredPreflightProbes(f.project, f.options)).toMatchObject({ released: 0, held: [] });
    expect(await tasks('m')).toEqual([['x', 'active', false], ['y', 'active', false], ['z', 'active', false]]);
  } finally { f.store.close(); }
}, 120_000);

it('REVISE 2698: two uncertain (2693) holds of one Run are both released by one proven check; a second check releases nothing', async context => {
  const f = await fixture(context, REQUIREMENTS, 2);
  try {
    const [x, y] = await multiRun(f, 'm', ['x', 'y']);
    vi.spyOn(DockerSupervisor.prototype, 'probe').mockResolvedValueOnce({ uncertain: probeName('5') }).mockResolvedValueOnce({ uncertain: probeName('6') });
    for (const identity of [x!, y!]) await expect(executeConfiguredTask(f.project, identity, f.options)).rejects.toMatchObject({ code: 'EXECUTION_ENVIRONMENT_UNCERTAIN' });
    expect((await f.store.loadRun('s', 'm'))!.progress.map(task => task.unresolvedEffects)).toEqual([true, true]);
    const listed = await f.store.environmentProbeHolds({ scopeId: 's', runId: 'm' });
    expect(listed.map(hold => hold.runRevision)).toEqual([listed[0]!.runRevision, listed[0]!.runRevision]);
    expect(await settleConfiguredEnvironmentProbes(f.project, { scopeId: 's', runId: 'm' }, f.options)).toEqual({ released: 2, held: [] });
    // A replay of a listed hold returns its receipt: nothing is released twice and the Run revision does not move.
    const revision = (await f.store.loadRun('s', 'm'))!.revision, replay = await f.store.settleEnvironmentProbe(listed[1]!);
    expect(replay.commandId).toBe(`settle-probe-${y!.attemptId}-${listed[1]!.runRevision}`); expect((await f.store.loadRun('s', 'm'))!.revision).toBe(revision);
    expect(await settleConfiguredEnvironmentProbes(f.project, { scopeId: 's', runId: 'm' }, f.options)).toEqual({ released: 0, held: [] });
    expect((await f.store.loadRun('s', 'm'))!.progress.map(task => [task.phase, task.unresolvedEffects])).toEqual([['pending', false], ['pending', false]]);
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
