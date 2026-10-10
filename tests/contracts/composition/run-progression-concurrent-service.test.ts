import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { readLocalOsIdentity } from '#adapters/index.js';
import { ErrorRegistry, clearConfigCache, productResourcePath } from '#platform/index.js';
import { startConfiguredRuntimeService, createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { ensureConfiguredTerminalIdentity } from '#composition/core/scoped-request/index.js';
import * as execution from '#composition/core/execution/index.js';
import { RuntimeServiceLifecycle } from '#engine/index.js';
import { prepareConfiguredRunRuntime, type RunProgressionObserver } from '#composition/core/run-progression/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const nativeAvailable = process.platform === 'linux' && existsSync(resolve('src/adapters/core/local-runtime-socket/native/build/Release/peer_credentials.node'));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function bounded<T>(promise: Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CONCURRENT_SERVICE_TIMEOUT')), 3000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function fixture(maxConcurrentExecutions: number, parkAuthority = false) {
  const project = await mkdtemp(join(tmpdir(), 'deckent-run-concurrent-service-')); roots.push(project);
  await mkdir(join(project, '.deckent'), { mode: 0o700 });
  const home = join(project, 'home');
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(project, 'data') },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    runRuntime: { pollIntervalMs: 10, failureBackoffMs: 100, pageSize: 8, maxConcurrentRuns: 2, maxReservationsPerTurn: 1, maxConsecutiveFailures: 2 },
    service: { identity: { scopeId: 's', serviceId: 'runtime' }, maxConcurrentRequests: 4, maxConcurrentExecutions, shutdownGraceMs: 2000 },
  }));
  const opened = await openConfiguredAttemptStore(project, { env }), actor = readLocalOsIdentity();
  const principals = [{ issuer: actor.issuer, subject: actor.subject }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'concurrent-test', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['inspect', 'reserve', ...parkAuthority ? ['cancel'] : []], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'stop', effect: 'allow', actions: ['shutdown'], scopes: ['s'], principals, resource: { kind: 'service', ids: ['runtime'] } },
  ] }), { mode: 0o600 });
  await ensureConfiguredTerminalIdentity(project, 's', { env });
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  const capacity = { executionSlots: 2, inFlightSlots: 2 };
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity });
  for (const runId of ['a', 'b']) await opened.store.createRun({ commandId: `create-${runId}`, actor: { id: actor.id, issuer: actor.issuer, subject: actor.subject }, identity: { scopeId: 's', runId, layoutRevision: opened.layout.revision },
    graph, execution: fixtureExecution(graph), now: 0, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['t'] } });
  const layout = opened.layout; opened.store.close(); return { project, env, layout, actor };
}

it('[requires built Linux peer_credentials.node] governed service shutdown drains both concurrent Run turns before releasing custody (controlled execution port)', async context => {
  if (!nativeAvailable) context.skip('LOCAL_RUNTIME_UNSUPPORTED: requires built Linux peer_credentials.node');
  const f = await fixture(2), gates = [deferred(), deferred()], started = deferred();
  const starts: string[] = [], observed: string[] = [], errors: string[] = [], firstPublished = deferred();
  vi.spyOn(execution, 'executeConfiguredTask').mockImplementation(async (_project, identity) => {
    const index = starts.length; starts.push(identity.runId); if (starts.length === 2) started.resolve();
    await gates[index]!.promise;
    return undefined as unknown as Awaited<ReturnType<typeof execution.executeConfiguredTask>>;
  });
  const service = await startConfiguredRuntimeService(f.project, { onPage() {}, onError() {},
    onRunProgression(query, result) { observed.push(query.runId); if (observed.length === 1) firstPublished.resolve(); expect(result.stopped).toBe(true); expect(result).not.toHaveProperty('waitedForSlotMs'); },
    onRunProgressionError(_query, error) { errors.push(error.code); },
  }, { env: f.env });
  try {
    await bounded(started.promise); expect([...starts].sort()).toEqual(['a', 'b']);
    const client = createConfiguredRuntimeClient(f.project, { env: f.env }), descriptor = await client.describeService();
    await client.shutdownService({ schemaVersion: 1, commandId: 'stop-concurrent', serviceId: 'runtime', instanceId: descriptor.instanceId, reason: 'test both turns' });
    let done = false; void service.done.then(() => { done = true; });
    gates[0]!.resolve(); await bounded(firstPublished.promise); expect(done).toBe(false); expect(observed).toEqual([starts[0]!]);
    gates[1]!.resolve(); await bounded(service.done); expect(observed).toEqual(starts); expect(errors).toEqual([]);
    const opened = await openConfiguredAttemptStore(f.project, { env: f.env });
    try { expect(await opened.store.readServiceShutdown({ scopeId: 's', serviceId: 'runtime', commandId: 'stop-concurrent' })).toMatchObject({ outcome: { state: 'clean' } }); }
    finally { opened.store.close(); }
  } finally { gates.forEach(gate => gate.resolve()); await service.stop(); await service.done; }
}, 10000);

it('[requires built Linux peer_credentials.node] shares execution cap across concurrent reserved Runs and adds slot wait to the completed observer only (controlled execution port)', async context => {
  if (!nativeAvailable) context.skip('LOCAL_RUNTIME_UNSUPPORTED: requires built Linux peer_credentials.node');
  const f = await fixture(1), gates = [deferred(), deferred()], first = deferred(), second = deferred();
  const starts: string[] = [], observed = new Map<string, Parameters<NonNullable<RunProgressionObserver['onRun']>>[1]>(), errors: string[] = [];
  vi.spyOn(execution, 'executeConfiguredTask').mockImplementation(async (_project, identity) => {
    const index = starts.length; starts.push(identity.runId); (index === 0 ? first : second).resolve(); await gates[index]!.promise;
    return undefined as unknown as Awaited<ReturnType<typeof execution.executeConfiguredTask>>;
  });
  const service = await startConfiguredRuntimeService(f.project, { onPage() {}, onError() {},
    onRunProgression(query, result) { observed.set(query.runId, result); }, onRunProgressionError(_query, error) { errors.push(error.code); },
  }, { env: f.env });
  try {
    await bounded(first.promise);
    await expect.poll(async () => {
      const opened = await openConfiguredAttemptStore(f.project, { env: f.env });
      try { return ((await opened.store.loadRun('s', 'a'))!.bindings.length + (await opened.store.loadRun('s', 'b'))!.bindings.length); } finally { opened.store.close(); }
    }).toBe(2);
    await new Promise(resolve => setTimeout(resolve, 25)); expect(starts).toHaveLength(1);
    gates[0]!.resolve(); await bounded(second.promise); expect([...starts].sort()).toEqual(['a', 'b']);
    const stopping = service.stop(); gates[1]!.resolve(); await bounded(stopping); await bounded(service.done);
    expect(errors).toEqual([]); expect(observed.get(starts[0]!)).not.toHaveProperty('waitedForSlotMs');
    expect(observed.get(starts[1]!)!.waitedForSlotMs).toBeGreaterThan(0);
    expect(observed.get(starts[1]!)!.attempted).toBe(1);
    expect(JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8')).service.maxConcurrentExecutions).toBe(1);
  } finally { gates.forEach(gate => gate.resolve()); await service.stop(); await service.done; }
}, 10000);


it.for([1, 2])('configured driver shares execution cap=%s and drains both reserved Run turns without a socket (controlled execution port)', async (cap, context) => {
  if (process.platform === 'win32') {
    await expect(fixture(cap)).rejects.toMatchObject({ code: 'MANAGED_FILE_UNSUPPORTED' });
    context.skip('MANAGED_FILE_UNSUPPORTED: configured ledger custody requires POSIX ownership and permissions');
  }
  const f = await fixture(cap), gates = [deferred(), deferred()], first = deferred(), second = deferred(), firstObserved = deferred(), controller = new AbortController();
  const starts: string[] = [], observed = new Map<string, Parameters<NonNullable<RunProgressionObserver['onRun']>>[1]>(), errors: string[] = [];
  vi.spyOn(execution, 'executeConfiguredTask').mockImplementation(async (_project, identity) => {
    const index = starts.length; starts.push(identity.runId); (index === 0 ? first : second).resolve();
    await gates[index]!.promise;
    return undefined as unknown as Awaited<ReturnType<typeof execution.executeConfiguredTask>>;
  });
  let work: Promise<void> = Promise.resolve();
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 4, maxConcurrentExecutions: cap }, () => {
    controller.abort(); return work;
  }, { async wait(milliseconds, signal) {
    if (signal.aborted) return;
    await new Promise<void>(done => { const timer = setTimeout(done, milliseconds); signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true }); });
  } });
  const loop = await prepareConfiguredRunRuntime(f.project, {
    onRun(query, result) { observed.set(query.runId, result); if (query.runId === starts[0]) firstObserved.resolve(); }, onError(_query, error) { errors.push(error.code); },
  }, (operation, onSlotWait) => lifecycle.admitExecution(operation, onSlotWait), { env: f.env });
  work = loop.run(controller.signal);
  try {
    await bounded(first.promise);
    await expect.poll(async () => {
      const opened = await openConfiguredAttemptStore(f.project, { env: f.env });
      try { return ((await opened.store.loadRun('s', 'a'))!.bindings.length + (await opened.store.loadRun('s', 'b'))!.bindings.length); } finally { opened.store.close(); }
    }).toBe(2);
    // A durable reservation precedes execution admission; join the second start when capacity allows it.
    if (cap === 2) await bounded(second.promise);
    else await new Promise(resolve => setTimeout(resolve, 25));
    expect(starts).toHaveLength(cap);
    if (cap === 1) { gates[0]!.resolve(); await bounded(second.promise); }
    const stopping = lifecycle.stop(2000); let settled = false; void stopping.then(() => { settled = true; });
    if (cap === 2) gates[0]!.resolve();
    // Releasing an execution slot does not order the Run's later publication. Observe it before releasing the second execution.
    await bounded(firstObserved.promise); expect([...observed.keys()]).toEqual([starts[0]!]); expect(settled).toBe(false);
    gates[1]!.resolve(); await expect(bounded(stopping)).resolves.toMatchObject({ state: 'clean', remainingRequests: 0, recoveryPending: false });
    await work; expect([...starts].sort()).toEqual(['a', 'b']); expect(errors).toEqual([]); expect([...observed.keys()]).toEqual(starts);
    expect(observed.get(starts[0]!)).not.toHaveProperty('waitedForSlotMs');
    if (cap === 1) expect(observed.get(starts[1]!)!.waitedForSlotMs).toBeGreaterThan(0);
    else expect(observed.get(starts[1]!)).not.toHaveProperty('waitedForSlotMs');
    expect(observed.get(starts[1]!)!.attempted).toBe(1);
  } finally { controller.abort(); gates.forEach(gate => gate.resolve()); await work; await lifecycle.stop(2000); }
}, 10000);


it.for([true, false])('configured progression persists a typed park when cancel authority=%s; denied parking stops dispatch with attention', async (parkAuthority, context) => {
  if (process.platform === 'win32') {
    await expect(fixture(2, parkAuthority)).rejects.toMatchObject({ code: 'MANAGED_FILE_UNSUPPORTED' });
    context.skip('MANAGED_FILE_UNSUPPORTED: configured ledger uses POSIX custody');
  }
  const f = await fixture(2, parkAuthority), controller = new AbortController(), reports: string[] = [], starts: string[] = [];
  vi.spyOn(execution, 'executeConfiguredTask').mockImplementation(async (_root, identity) => {
    starts.push(identity.runId); if (identity.runId === 'a') throw ErrorRegistry.createError('SUPERVISOR_CONTROL_FAILED');
    return undefined as unknown as Awaited<ReturnType<typeof execution.executeConfiguredTask>>;
  });
  const attention = deferred();
  const loop = await prepareConfiguredRunRuntime(f.project, { onError(_query, error) {
    reports.push(error.code);
    if (error.code === (parkAuthority ? 'RUN_PROGRESSION_PARKED' : 'RUN_PROGRESSION_PARK_UNAVAILABLE')) attention.resolve();
  } }, work => work(), { env: f.env });
  const work = loop.run(controller.signal);
  try {
    await bounded(attention.promise);
    await new Promise(resolve => setTimeout(resolve, 140)); // more than one backoff: no third failing dispatch
    expect(starts.filter(runId => runId === 'a')).toHaveLength(2); expect(starts).toContain('b');
    expect(reports.filter(code => code === 'SUPERVISOR_CONTROL_FAILED')).toHaveLength(2);
    const opened = await openConfiguredAttemptStore(f.project, { env: f.env });
    try {
      const run = (await opened.store.loadRun('s', 'a'))!;
      expect(run.progress[0]!.phase).toBe('active'); expect(run.bindings).toHaveLength(1);
      expect(run.state).toEqual(parkAuthority ? { kind: 'parked', reason: 'progression-failed', failureCode: 'SUPERVISOR_CONTROL_FAILED', since: expect.any(Number), deadline: expect.any(Number) } : { kind: 'running' });
      if (parkAuthority) expect((await opened.store.listRunProgression({ actor: { id: f.actor.id, issuer: f.actor.issuer, subject: f.actor.subject }, after: null, limit: 8 })).items).not.toContainEqual({ scopeId: 's', runId: 'a' });
      else expect(reports).toContain('POLICY_DENIED');
    } finally { opened.store.close(); }
  } finally { controller.abort(); await work; }
});
