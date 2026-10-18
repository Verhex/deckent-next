import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { DockerSupervisor, openSqliteAuditStore, readLocalOsIdentity } from '#adapters/index.js';
import { classifyLaunchRefusal, DependencyTreePatternCache, DispatchPreparationGuard, WORKER_TREE_SCAN_ADMISSION } from '#engine/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

// R2 (owner/lead D3a 2026-10-18): the S6 gate on the real execution path with scan admission and the in-flight shared dependency scan.
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** A project with a separate work target, `tasks` independent tasks reserved at once, and a declared dependency bind `deps` → `/deps`. */
async function fixture(context: TestContext, tasks: number, dependencies: Record<string, string | Buffer>, secretGate: object = {}) {
  if (process.platform !== 'linux') context.skip('Docker execution and the private ledger are Linux-only here');
  const root = await mkdtemp(join(tmpdir(), 'worker-tree-admission-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home'), target = join(root, 'target'), baseRef = 'refs/heads/deckent/base';
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const git = (...args: string[]) => exec('/usr/bin/git', ['-C', project, ...args]);
  await git('init', '-q'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(project, 'README.md'), '# project\n'); await git('add', '--', 'README.md'); await git('commit', '-q', '-m', 'base');
  await exec('/usr/bin/git', ['clone', '-q', project, target]); await exec('/usr/bin/git', ['-C', target, 'branch', 'deckent/base']);
  for (const [path, content] of Object.entries(dependencies)) { await mkdir(join(project, path, '..'), { recursive: true }); await writeFile(join(project, path), content); }
  const options = { env: { HOME: home, USERPROFILE: home } }, registry = fixtureDockerRegistry(['fixture']), parameters = registry.profiles[0]!.parameters;
  Object.assign(parameters, { readOnlyMounts: [{ source: 'deps', target: '/deps', dependencyTree: { lockfile: '.package-lock.json' } }] });
  const { argv: _argv, readOnlyMounts: _mounts, ...docker } = parameters as typeof parameters & { readOnlyMounts?: unknown }; void _argv; void _mounts;
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, max_workers: tasks, admission: { poolId: 'p', executionSlots: tasks, inFlightSlots: tasks,
    ordering: 'input-order', registry }, execution: { docker: { executable: '/usr/bin/docker', ...docker }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 },
    secretGate: { schemaVersion: 1, ...secretGate }, adoption: { targets: [baseRef] }, workTargets: { schemaVersion: 1, targets: [{ id: 't', kind: 'git', path: target, baseRef }] } } }));
  const opened = await openConfiguredAttemptStore(project, options), store = opened.store;
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: tasks, inFlightSlots: tasks } });
  const principal = { ...readLocalOsIdentity(), scopeIds: ['s'] }, principals = [{ issuer: principal.issuer, subject: principal.subject }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'target', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'work-target', ids: ['t'] } },
  ] }), { mode: 0o600 });
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: Array.from({ length: tasks }, (_, index) => ({ id: `t${index}`, kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] })),
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
  const identities = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve', expectedRevision: 0 }, options)).reservation.identities;
  const auditPage = async (kind: string) => {
    const audit = await openSqliteAuditStore(productResourcePath(opened.layout, 'ledger'), { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' });
    try { return audit.page('s', 0, 1000).map(record => record.event.subject).filter(subject => subject.kind === kind); } finally { audit.close(); }
  };
  return { project, options, store, identities, auditPage, workspaces: productResourcePath(opened.layout, 'workspaces'), gateCache: productResourcePath(opened.layout, 'treeScanCache') };
}
/** Holds every dispatch at the secret-gate phase until `count` have arrived, so all of them reach the gate while one dependency scan is in flight. */
function secretGateBarrier(count: number) {
  let arrived = 0, open!: () => void; const all = new Promise<void>(resolve => { open = resolve; });
  const enter = DispatchPreparationGuard.prototype.enter;
  vi.spyOn(DispatchPreparationGuard.prototype, 'enter').mockImplementation(async function (this: DispatchPreparationGuard, phase) {
    await enter.call(this, phase); if (phase !== 'secret-gate') return;
    if (++arrived === count) open(); await all;
  });
}
const binding = () => { const bytes = Buffer.alloc(20 * 1024 * 1024, 0x41); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]); return bytes; };
const userinfo = ['https://', 'fixture-user', ':', 'fixture-pass', '@example.invalid'].join('');

it('13 concurrent dispatches over one declared dependency bind scan it once: all pass the gate, each audited and journalled on its own', async context => {
  const f = await fixture(context, 13, { 'deps/.package-lock.json': '{"lockfileVersion":3}\n', 'deps/native/binding.node': binding(), 'deps/zod/tests/string.test.ts': `parse("${userinfo}");\n` });
  try {
    expect(f.identities).toHaveLength(13);
    const capture = vi.spyOn(DockerSupervisor.prototype, 'captureProfile').mockRejectedValue(Object.assign(new Error('reached the supervisor'), { code: 'FIXTURE_REACHED' }));
    const opened = vi.spyOn(DependencyTreePatternCache, 'open'), before = WORKER_TREE_SCAN_ADMISSION.statistics();
    secretGateBarrier(13);
    const started = performance.now();
    const results = await Promise.all(f.identities.map(identity => executeConfiguredTask(f.project, identity, f.options).then(() => 'passed', () => 'stopped')));
    const elapsedMs = Math.round(performance.now() - started), after = WORKER_TREE_SCAN_ADMISSION.statistics();
    // Measurement (workload: 13 dispatches, one 20 MiB native binding + fixtures in the bind; env/version in HANDOFF-S2).
    console.info(`R2 measurement: 13 dispatches gated in ${elapsedMs} ms; dependency scans started ${after.started - before.started}, joined ${after.joined - before.joined}, slot waits ${after.waited - before.waited}`);
    // Every dispatch passed the gate and reached the supervisor (stopped there by the fixture: no container).
    expect(results).toEqual(Array(13).fill('stopped')); expect(capture).toHaveBeenCalledTimes(13);
    expect(after.started - before.started).toBe(1); expect(after.joined - before.joined).toBe(12); expect(opened).toHaveBeenCalledTimes(1);
    expect(await f.auditPage('worker-tree-refused')).toEqual([]);
    const excluded = await f.auditPage('worker-tree-excluded');
    expect(excluded).toHaveLength(13); expect(new Set(excluded.map(subject => (subject as { attemptId: string }).attemptId))).toEqual(new Set(f.identities.map(identity => identity.attemptId)));
    expect(excluded.every(subject => (subject as { count: number }).count === 2)).toBe(true);
    expect(await readdir(f.gateCache)).toHaveLength(1);
  } finally { f.store.close(); }
}, 120_000);

it('a secret in the shared dependency scan refuses every waiting Attempt: each closed, audited and released, no container', async context => {
  const f = await fixture(context, 4, { 'deps/.package-lock.json': '{"lockfileVersion":3}\n', 'deps/native/binding.node': binding(), 'deps/zod/.npmrc': '//registry.npmjs.org/:_authToken=fixture-value\n' });
  try {
    const capture = vi.spyOn(DockerSupervisor.prototype, 'captureProfile'), before = WORKER_TREE_SCAN_ADMISSION.statistics();
    secretGateBarrier(4);
    const failures = await Promise.all(f.identities.map(identity => executeConfiguredTask(f.project, identity, f.options).catch((error: unknown) => error)));
    expect(failures).toEqual(Array(4).fill(expect.objectContaining({ code: 'WORKER_TREE_SECRET_REFUSED', params: expect.objectContaining({ count: 1, paths: 'deps/zod/.npmrc (deny-path:**/.npmrc)' }) })));
    expect(WORKER_TREE_SCAN_ADMISSION.statistics().started - before.started).toBe(1);
    expect(capture).not.toHaveBeenCalled(); expect(await readdir(f.workspaces)).toEqual([]);
    expect(await f.auditPage('worker-tree-refused')).toHaveLength(4);
    for (const identity of f.identities) expect((await f.store.load('s', identity.attemptId))!.lastObservation?.result).toEqual({ kind: 'launch-refused', code: 'WORKER_TREE_SECRET_REFUSED' });
  } finally { f.store.close(); }
}, 120_000);

it('a time refusal is deferred (attempt stays open, nothing dispatched) up to maxTimeRefusals; the next one closes the Attempt', async context => {
  // A 1 ms deadline cannot read the 20 MiB binding: a load-shaped `time` refusal on every turn.
  const f = await fixture(context, 1, { 'deps/.package-lock.json': '{"lockfileVersion":3}\n', 'deps/native/binding.node': binding() }, { timeoutMs: 1, maxTimeRefusals: 1 });
  try {
    const capture = vi.spyOn(DockerSupervisor.prototype, 'captureProfile'), identity = f.identities[0]!;
    const first = await executeConfiguredTask(f.project, identity, f.options).catch((error: unknown) => error);
    expect(first).toMatchObject({ code: 'WORKER_TREE_SCAN_DEFERRED', params: { limit: 'timeoutMs', bound: 1, refusals: 1, maxTimeRefusals: 1 } });
    expect(classifyLaunchRefusal(first)).toEqual({ disposition: 'transient' });
    expect((await f.store.load('s', identity.attemptId))!.lastObservation).toBeNull(); expect(await readdir(f.workspaces)).toEqual([]);
    await expect(executeConfiguredTask(f.project, identity, f.options)).rejects.toMatchObject({ code: 'WORKER_TREE_SCAN_INCOMPLETE', params: { limit: 'timeoutMs', bound: 1 } });
    expect((await f.store.load('s', identity.attemptId))!.lastObservation?.result).toEqual({ kind: 'launch-refused', code: 'WORKER_TREE_SCAN_INCOMPLETE' });
    expect(capture).not.toHaveBeenCalled();
    expect(await f.auditPage('worker-tree-refused')).toEqual(Array(2).fill(expect.objectContaining({ code: 'WORKER_TREE_SCAN_INCOMPLETE', limit: 'time', count: 0 })));
  } finally { f.store.close(); }
}, 120_000);
