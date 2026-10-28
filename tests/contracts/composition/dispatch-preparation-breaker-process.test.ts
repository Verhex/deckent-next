import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { DockerSupervisor, openSqliteAuditStore, readLocalOsIdentity } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { applyConfiguredRunLifecycle, createConfiguredRun, inspectConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { inspectMonitor } from '#composition/core/monitor/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { runCommand } from '#surfaces/core/cli/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

// Crash-loop breaker (owner-approved before beta, pilot1 2026-10-17): a process that dies while it prepares a dispatch leaves a durable,
// unsettled per-Attempt record; each later start counts one abnormal end, and at the bound (default 2) the Run is parked with the typed
// reason instead of being dispatched again. The child process is the built composition (`npm run build` first); it is killed at the secret gate.
const exec = promisify(execFile), roots: string[] = [];
const program = resolve('tests/fixtures/dispatch-preparation-abort.mjs');
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(context: TestContext, taskIds: readonly string[] = ['a']) {
  if (process.platform !== 'linux') context.skip('the private ledger and the killed child process are Linux-only here');
  const root = await mkdtemp(join(tmpdir(), 'dispatch-preparation-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const git = (...args: string[]) => exec('/usr/bin/git', ['-C', project, ...args]);
  await git('init', '-q'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'README.md'), '# clean project\n'); await git('add', '--', 'README.md'); await git('commit', '-q', '-m', 'base');
  const env = { ...process.env, HOME: home, USERPROFILE: home }, options = { env }, registry = fixtureDockerRegistry(['fixture']);
  const { argv: _argv, ...docker } = registry.profiles[0]!.parameters; void _argv;
  const slots = taskIds.length;
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: slots, inFlightSlots: slots,
    ordering: 'input-order', registry }, execution: { docker: { executable: '/usr/bin/docker', ...docker }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const opened = await openConfiguredAttemptStore(project, options), store = opened.store;
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: slots, inFlightSlots: slots } });
  const principal = { ...readLocalOsIdentity(), scopeIds: ['s'] }, principals = [{ issuer: principal.issuer, subject: principal.subject }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', restrictions: [], grants: [
    // `cancel` is the authority every progression park needs (the runtime loop's own park included); `run-decision resume` is the operator's.
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect', 'cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'resume', effect: 'allow', actions: ['resume'], scopes: ['s'], principals, resource: { kind: 'run-decision', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'monitor', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: taskIds.map(id => ({ id, kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] })),
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
  const identities = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve', expectedRevision: 0 }, options)).reservation.identities, identity = identities[0]!;
  /** One service start: its start-up progression turn in a fresh process (a fresh instance). */
  const start = (mode: 'abort' | 'abort-2' | 'clean' | 'refuse-die') => new Promise<{ code: number | null; signal: NodeJS.Signals | null; result: unknown }>((done, fail) => {
    const child = spawn(process.execPath, [program, mode], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); }); child.on('error', fail);
    child.on('close', (code, signal) => done({ code, signal, result: out.trim() ? JSON.parse(out.trim()) : null }));
  });
  const audit = async (kind: string) => {
    const store = await openSqliteAuditStore(productResourcePath(opened.layout, 'ledger'), { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' });
    try { return store.page('s', 0, 100).map(record => record.event.subject).filter(subject => subject.kind === kind); } finally { store.close(); }
  };
  const directory = join(productResourcePath(opened.layout, 'crashes'), 'dispatch-preparation');
  const records = () => readdir(directory).then(names => names.filter(name => name.endsWith('.json')), () => []);
  const contents = async () => Promise.all((await records()).map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')) as { identity: { taskId: string }; aborts: number; phase: string; park: unknown }));
  return { project, options, store, identity, identities, start, audit, records, contents };
}

it('two service starts die in the secret gate; the third parks the Run with DISPATCH_PREPARATION_ABORTED, nothing is dispatched again until an explicit resume', async context => {
  const f = await fixture(context);
  try {
    // Start 1 and restart 1: each dies in the gate (pilot1). Nothing is claimed; the Run keeps progressing.
    expect(await f.start('abort')).toMatchObject({ code: null, signal: 'SIGKILL', result: null });
    expect(await f.start('abort')).toMatchObject({ code: null, signal: 'SIGKILL', result: null });
    expect(await f.store.loadBoundDispatch(f.identity)).toBeNull();
    // Restart 2: two abnormal ends reach the default bound. The gate is never reached again (it would kill this process too).
    const third = await f.start('abort');
    expect(third).toMatchObject({ code: 0, signal: null, result: { ok: false, code: 'DISPATCH_PREPARATION_ABORTED',
      params: { task: 'a', attempt: f.identity.attemptId, phase: 'secret-gate', aborts: 2, bound: 2 } } });
    const parked = (await f.store.loadRun('s', 'r'))!;
    expect(parked.state).toEqual({ kind: 'parked', reason: 'progression-failed', failureCode: 'DISPATCH_PREPARATION_ABORTED', since: expect.any(Number), deadline: expect.any(Number) });
    expect(parked.progress[0]).toMatchObject({ phase: 'active', unresolvedEffects: false });
    expect(await f.store.loadBoundDispatch(f.identity)).toBeNull();
    expect((await f.store.load('s', f.identity.attemptId))!.lastObservation).toBeNull();
    // One crash-marker event per counted abnormal end, naming the last phase; then the existing park audit.
    expect(await f.audit('dispatch-preparation-aborted')).toEqual([1, 2].map(aborts => ({ kind: 'dispatch-preparation-aborted', runId: 'r', taskId: 'a',
      attemptId: f.identity.attemptId, phase: 'secret-gate', aborts, bound: 2 })));
    expect(await f.audit('run-lifecycle')).toMatchObject([{ action: 'park-progression', deciderClass: 'system', runId: 'r' }]);
    // Further restarts while parked: no preparation, no dispatch, no new marker.
    expect(await f.start('abort')).toMatchObject({ code: 0, signal: null, result: { ok: true, attempted: 0 } });
    expect(await f.audit('dispatch-preparation-aborted')).toHaveLength(2);
    // Visible in run inspect (EN/TR) and the monitor.
    for (const [locale, lines] of [['en', ['Progression failure: DISPATCH_PREPARATION_ABORTED', 'dispatch preparation ended abnormally']],
      ['tr', ['İlerleme hatası: DISPATCH_PREPARATION_ABORTED', 'gönderim hazırlığı olağan dışı']]] as const) {
      const output: string[] = [];
      await runCommand(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], { root: f.project, env: f.options.env, stdout: { write(text: string) { output.push(text); } },
        inspectRun: inspectConfiguredRun });
      for (const line of lines) expect(output.join('')).toContain(line);
    }
    const monitor = (await loadMonitorSurface()).buildMonitorView(await inspectMonitor(f.project, f.options), 'en', true).tabs.runs
      .flatMap(block => block.kind === 'table' ? block.rows : []).flatMap(row => row.detail().map(line => line.map(item => item.text).join(''))).join('\n');
    expect(monitor).toContain('DISPATCH_PREPARATION_ABORTED');
    // The operator resumes through the existing path; the next start prepares from a fresh count and reaches the supervisor.
    await applyConfiguredRunLifecycle(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'resume', action: 'resume', expectedRevision: parked.revision }, f.options);
    expect((await f.store.loadRun('s', 'r'))!.state).toEqual({ kind: 'running' });
    const capture = vi.spyOn(DockerSupervisor.prototype, 'captureProfile').mockRejectedValue(Object.assign(new Error('reached the supervisor'), { code: 'FIXTURE_REACHED' }));
    await expect(executeConfiguredTask(f.project, f.identity, f.options)).rejects.toBeTruthy();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await f.records()).toEqual([]);
    expect(await f.audit('dispatch-preparation-aborted')).toHaveLength(2);
  } finally { f.store.close(); }
}, 120_000);

// BeUser D-05: Node 26 ended the service for a FileHandle collected after a typed refusal had already settled the record, so no restart counted
// the death and every start resumed the Run into it. A transient refusal now keeps the record: the next start in another instance counts it.
it('a Run whose attempt is refused and the service then dies, twice, is parked for the person on the next start instead of resumed into the same death', async context => {
  const f = await fixture(context);
  try {
    for (let start = 0; start < 2; start++) {
      const died = await f.start('refuse-die');
      expect(died).toMatchObject({ code: null, signal: 'SIGKILL' });
      expect(JSON.stringify(died.result)).not.toContain('DISPATCH_PREPARATION_ABORTED');
    }
    const third = await f.start('refuse-die');
    expect(third.result).toMatchObject({ ok: false, code: 'DISPATCH_PREPARATION_ABORTED', params: { task: 'a', phase: 'workspace', aborts: 2, bound: 2 } });
    expect((await f.store.loadRun('s', 'r'))!.state).toMatchObject({ kind: 'parked', reason: 'progression-failed', failureCode: 'DISPATCH_PREPARATION_ABORTED' });
    expect(await f.audit('dispatch-preparation-aborted')).toHaveLength(2);
  } finally { f.store.close(); }
}, 120_000);

it('an ordinary refusal settles the record: a later start in another process counts nothing and the Run is never parked by the breaker', async context => {
  const f = await fixture(context);
  try {
    const capture = vi.spyOn(DockerSupervisor.prototype, 'captureProfile').mockRejectedValue(Object.assign(new Error('reached the supervisor'), { code: 'FIXTURE_REACHED' }));
    for (let turn = 0; turn < 3; turn++) await expect(executeConfiguredTask(f.project, f.identity, f.options)).rejects.toBeTruthy();
    expect(capture).toHaveBeenCalledTimes(3); expect(await f.records()).toEqual([]);
    // A clean start in a new process reaches the real (absent) supervisor and fails there: settled again, no marker, still running.
    expect(await f.start('clean')).toMatchObject({ code: 0, signal: null, result: { ok: false } });
    expect(await f.records()).toEqual([]); expect(await f.audit('dispatch-preparation-aborted')).toEqual([]);
    expect((await f.store.loadRun('s', 'r'))!.state).toEqual({ kind: 'running' });
  } finally { f.store.close(); }
}, 120_000);

it('two Attempts of one Run trip in the same start: one park holds both, and one explicit resume releases both (pilot1 had three)', async context => {
  const f = await fixture(context, ['a', 'b']);
  try {
    expect(f.identities.map(identity => identity.taskId).sort()).toEqual(['a', 'b']);
    // Both attempts prepare concurrently and both die inside the gate, twice.
    for (let start = 0; start < 2; start++) expect(await f.start('abort-2')).toMatchObject({ code: null, signal: 'SIGKILL', result: null });
    expect(await f.start('abort-2')).toMatchObject({ code: 0, signal: null, result: { ok: false, code: 'DISPATCH_PREPARATION_ABORTED' } });
    const parked = (await f.store.loadRun('s', 'r'))!;
    expect(parked.state).toMatchObject({ kind: 'parked', reason: 'progression-failed', failureCode: 'DISPATCH_PREPARATION_ABORTED' });
    expect((await f.audit('dispatch-preparation-aborted')).map(event => 'phase' in event ? event.phase : null)).toEqual(Array(4).fill('secret-gate'));
    const parks = async () => (await f.audit('run-lifecycle')).filter(event => 'action' in event && event.action === 'park-progression');
    expect(await parks()).toHaveLength(1);
    expect((await f.contents()).map(record => [record.identity.taskId, record.aborts, record.park !== null]).sort()).toEqual([['a', 2, true], ['b', 2, true]]);
    // One resume; each attempt then prepares again and reaches the supervisor. No second park.
    await applyConfiguredRunLifecycle(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'resume', action: 'resume', expectedRevision: parked.revision }, f.options);
    const capture = vi.spyOn(DockerSupervisor.prototype, 'captureProfile').mockRejectedValue(Object.assign(new Error('reached the supervisor'), { code: 'FIXTURE_REACHED' }));
    for (const identity of f.identities) await expect(executeConfiguredTask(f.project, identity, f.options)).rejects.toMatchObject({ code: expect.not.stringMatching(/^DISPATCH_PREPARATION_ABORTED$/) });
    expect(capture).toHaveBeenCalledTimes(2);
    expect((await f.store.loadRun('s', 'r'))!.state).toEqual({ kind: 'running' });
    expect(await parks()).toHaveLength(1); expect(await f.records()).toEqual([]);
  } finally { f.store.close(); }
}, 120_000);
