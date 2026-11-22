import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { readLocalOsIdentity, withMcpPrincipal, localPrincipalChannel } from '#adapters/index.js';
import { ErrorRegistry, clearConfigCache, productResourcePath, sha256 } from '#platform/index.js';
import { runProgressionLines } from '#surfaces/core/recovery-text/index.js';
import { main } from '#surfaces/core/cli/index.js';
import { doctorChecks } from '#surfaces/core/doctor/index.js';
import { startConfiguredRuntimeService, createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { openConfiguredAttemptStore } from '../support/configured-open.js';
import { ensureConfiguredTerminalIdentity } from '#composition/core/scoped-request/index.js';
import * as scopedRequest from '#composition/core/scoped-request/index.js';
import * as execution from '#composition/core/execution/index.js';
import * as runs from '#composition/core/runs/index.js';
import { RuntimeServiceLifecycle, RunSessionRegistry, withRunProgressionSession, withRunProgressionObservation } from '#engine/index.js';
import { prepareConfiguredRunRuntime, type RunProgressionObserver } from '#composition/core/run-progression/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { hostBound } from '../support/host-bounds.js';
import { dispatchAdmission, dockerDispatchProfile } from '../support/custody.js';

const nativeAvailable = process.platform === 'linux' && existsSync(resolve('src/adapters/core/local-runtime-socket/native/build/Release/peer_credentials.node'));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function bounded<T>(promise: Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CONCURRENT_SERVICE_TIMEOUT')), hostBound(3000));
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function fixture(maxConcurrentExecutions: number, parkAuthority = false, aiAdmission = false, workInput = false) {
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
  const graph = { schemaVersion: workInput ? 3 as const : 2 as const, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'],
    ...(workInput ? { workInput: { schemaVersion: 1, task: 'Retain changes', scope: { paths: ['note.txt'] }, acceptance: 'Retained evidence',
      model: { channelId: 'fixture-channel', modelId: 'fixture-model', auxiliaryModelIds: [] } } } : {}) }],
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  const capacity = { executionSlots: 2, inFlightSlots: 2 };
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity });
  const creator = aiAdmission ? withMcpPrincipal(readLocalOsIdentity) : actor;
  const execution = fixtureExecution({ ...graph, tasks: graph.tasks.map(task => {
    const { workInput: _input, ...rest } = task; void _input; return rest;
  }) });
  for (const runId of ['a', 'b']) await opened.store.createRun({ commandId: `create-${runId}`, actor: { id: creator.id, issuer: creator.issuer, subject: creator.subject }, identity: { scopeId: 's', runId, layoutRevision: opened.layout.revision },
    graph, execution, now: 0, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['t'] } });
  const layout = opened.layout; opened.store.close(); return { project, env, layout, actor };
}

it('[requires built Linux peer_credentials.node] governed service shutdown drains both concurrent Run turns before releasing custody (controlled execution port)', async context => {
  if (!nativeAvailable) context.skip('LOCAL_RUNTIME_UNSUPPORTED: requires built Linux peer_credentials.node');
  const f = await fixture(2), gates = [deferred(), deferred()], started = deferred();
  const signals: (AbortSignal | undefined)[] = [];
  const starts: string[] = [], observed: string[] = [], errors: string[] = [], firstPublished = deferred();
  vi.spyOn(execution, 'executeConfiguredTask').mockImplementation(async (_project, identity, _options, signal) => {
    signals.push(signal);
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
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
    const client = createConfiguredRuntimeClient(f.project, { env: f.env }), descriptor = await client.describeService();
    await client.shutdownService({ schemaVersion: 1, commandId: 'stop-concurrent', serviceId: 'runtime', instanceId: descriptor.instanceId, reason: 'test both turns' });
    await expect.poll(() => signals.every(signal => signal?.aborted)).toBe(true);
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
  let work: Promise<void> = Promise.resolve(), admissions = 0;
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 4, maxConcurrentExecutions: cap }, () => {
    controller.abort(); return work;
  }, { async wait(milliseconds, signal) {
    if (signal.aborted) return;
    await new Promise<void>(done => { const timer = setTimeout(done, milliseconds); signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true }); });
  } });
  const loop = await prepareConfiguredRunRuntime(f.project, {
    onRun(query, result) { observed.set(query.runId, result); if (query.runId === starts[0]) firstObserved.resolve(); }, onError(_query, error) { errors.push(error.code); },
  }, (operation, onSlotWait) => { admissions++; return lifecycle.admitExecution(operation, onSlotWait); }, { env: f.env });
  work = loop.run(controller.signal);
  try {
    await bounded(first.promise);
    await expect.poll(async () => {
      const opened = await openConfiguredAttemptStore(f.project, { env: f.env });
      try { return ((await opened.store.loadRun('s', 'a'))!.bindings.length + (await opened.store.loadRun('s', 'b'))!.bindings.length); } finally { opened.store.close(); }
    }).toBe(2);
    // A durable reservation precedes execution admission; join the second start when capacity allows it.
    if (cap === 2) await bounded(second.promise);
    // cap=1: release the first execution only once the second has asked for the slot (it then really waits). A fixed 25 ms was not enough
    // on hosted macOS: the second admission came after the slot was free, so no waitedForSlotMs was recorded (PLATFORM-TEMIZLIK open test).
    else await expect.poll(() => admissions).toBe(2);
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

async function personCustody(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  const opened = await openConfiguredAttemptStore(f.project, { env: f.env });
  try {
    const run = (await opened.store.loadRun('s', runId))!, identity = { ...run.identity, taskId: 't', attemptId: `attempt-${runId}`, generation: 1 };
    const actor = { id: f.actor.id, issuer: f.actor.issuer, subject: f.actor.subject };
    await opened.store.reserveRunTasks({ actor, scopeId: 's', runId, commandId: `reserve-${runId}`, expectedRevision: run.revision, now: 1, identities: [identity] });
    const claim = { request: { protocolVersion: 1 as const, identity, workspace: '/fixture', argv: ['fixture'] }, owner: 'fixture' };
    await opened.store.claimDispatch(dispatchAdmission(claim, dockerDispatchProfile()));
    await opened.store.grantLaunch({ claim, principal: { ...f.actor, scopeIds: ['s'] }, now: 2 });
    await opened.store.finishDispatch(claim, { handle: identity.attemptId, exitCode: 0, interrupted: false });
  } finally { opened.store.close(); }
}
function lifecycleReceipts(path: string) {
  const db = new DatabaseSync(path);
  try { return db.prepare('SELECT command FROM run_receipts').all().map(row => JSON.parse(String(row.command)) as { action: string; runId: string; actor: unknown }); }
  finally { db.close(); }
}

it.skipIf(process.platform === 'win32')('119-rev F2: AI and another inspected person cannot see the maintaining person policy; that person can', async () => {
  const f = await fixture(2, true, true); await personCustody(f, 'a');
  const ai = withMcpPrincipal(readLocalOsIdentity), other = { id: 'another-person', issuer: f.actor.issuer, subject: 'another-person', assurance: 'os-user' as const, scopeIds: ['s'] };
  const policyPath = productResourcePath(f.layout, 'policy'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  policy.grants.push(...[ai, other].map((principal, i) => ({ id: `reader-${i}`, effect: 'allow', actions: ['inspect'], scopes: ['s'],
    principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'run', ids: 'all' } })));
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const registry = new RunSessionRegistry(async () => { throw new Error('inspection must not sweep'); });
  const inspect = () => withRunProgressionSession(registry, () => withRunProgressionObservation({ observation: () => ({ suspended: false, parkUnavailable: false }) },
    () => runs.inspectConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'a' }, { env: f.env })));
  const own = (await inspect()).progression!;
  expect(own).toMatchObject({ state: 'maintenance-only', actorClass: 'person', actor: { id: f.actor.id, issuer: f.actor.issuer, subject: f.actor.subject }, policyRevision: 'concurrent-test' });
  expect(own.missing.length).toBeGreaterThan(0);
  const hidden = [(await withMcpPrincipal(inspect)).progression!];
  // The trusted scope-context seam supplies an already verified second reader; this adds no remote identity ingress.
  const load = scopedRequest.loadConfiguredScopeContext;
  vi.spyOn(scopedRequest, 'loadConfiguredScopeContext').mockImplementationOnce(async (...args) => ({ ...await load(...args), principal: other }));
  hidden.push((await inspect()).progression!);
  for (const diagnosis of hidden) {
    expect(diagnosis).toMatchObject({ state: 'maintenance-only', actorClass: 'person', reason: 'RUN_PROGRESSION_MAINTENANCE_ONLY', missing: [] });
    expect(diagnosis).not.toHaveProperty('actor'); expect(diagnosis).not.toHaveProperty('policyRevision');
    expect(JSON.stringify(diagnosis)).not.toContain(`"subject":"${f.actor.subject}"`);
  }
});

it.skipIf(process.platform === 'win32')('119-rev F5: broad coverage uncertainty is not a concrete blocker or an add-permission instruction (EN/TR)', async () => {
  const f = await fixture(2, true, true), ai = withMcpPrincipal(readLocalOsIdentity);
  const policyPath = productResourcePath(f.layout, 'policy'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const principals = [{ issuer: ai.issuer, subject: ai.subject }];
  policy.grants.push({ id: 'ai-run', effect: 'allow', actions: ['inspect', 'reserve', 'cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'ai-attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output', 'recover-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } });
  policy.restrictions.push({ id: 'other-attempt', actions: ['execute'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: ['unrelated-attempt'] } });
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const opened = await openConfiguredAttemptStore(f.project, { env: f.env });
  try {
    const run = (await opened.store.loadRun('s', 'b'))!, { config } = await scopedRequest.loadConfiguredScopeContext(f.project, 's', { env: f.env }, 'read');
    const key = { ledger: sha256(opened.path), companyId: config.company.id, scopeId: 's', runId: 'b', commandId: 'create-b', actor: { id: ai.id, issuer: ai.issuer, subject: ai.subject } };
    const registry = new RunSessionRegistry(async () => ({ run, intent: { actor: ai, commandId: 'create-b' }, approval: null, now: 1, admissionWindowMs: 1000 }));
    const pin = await registry.reserve(key); registry.admission(pin, run, ai, 'create-b'); await registry.finish(pin);
    const inspected = await withRunProgressionSession(registry, () => withRunProgressionObservation({ observation: () => ({ suspended: false, parkUnavailable: false }) },
      () => runs.inspectConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'b' }, { env: f.env })));
    expect(inspected.progression).toMatchObject({ state: 'unknown', session: 'eligible', reason: 'RUN_PROGRESSION_COVERAGE_UNVERIFIED', missing: [] });
    for (const locale of ['en', 'tr'] as const) {
      const text = runProgressionLines(inspected.run!, inspected.progression, locale).join('\n');
      expect(text).toContain(locale === 'en' ? 'no concrete execution blocker is proved' : 'somut bir yürütme engeli kanıtlanmadı');
      expect(text).not.toContain('--only ai-execution'); expect(text).not.toContain(locale === 'en' ? 'cancel this Run and propose it again' : 'bu işi iptal edip servis üzerinden yeniden önerin');
    }
  } finally { opened.store.close(); }
});

function inspectSession(f: Awaited<ReturnType<typeof fixture>>, runId: string, registry = new RunSessionRegistry(async () => { throw Error('inspection must not sweep'); })) {
  return withRunProgressionSession(registry, () => withRunProgressionObservation({ observation: () => ({ suspended: false, parkUnavailable: false }) },
    () => runs.inspectConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId }, { env: f.env })));
}

it.skipIf(process.platform === 'win32')('119-C4 rev2 point 1: cancelled-before-start inspect/list/doctor never resend; settled session loss still does (EN/TR)', async () => {
  const f = await fixture(2, true, true), opened = await openConfiguredAttemptStore(f.project, { env: f.env });
  const ai = withMcpPrincipal(readLocalOsIdentity), policyPath = productResourcePath(f.layout, 'policy'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  for (const kind of ['run', 'attempt']) policy.grants.push({ id: `ai-${kind}`, effect: 'allow', actions: ['inspect', 'reserve', 'cancel', 'execute', 'evaluate', 'read-output', 'recover-output'], scopes: ['s'],
    principals: [{ issuer: ai.issuer, subject: ai.subject }], resource: { kind, ids: 'all' } });
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  try {
    await opened.store.cancelRun({ scopeId: 's', runId: 'a', commandId: 'cancel-before-start',
      actor: { id: f.actor.id, issuer: f.actor.issuer, subject: f.actor.subject }, expectedRevision: 0 });
    expect((await opened.store.loadRun('s', 'a'))!.state).toMatchObject({ kind: 'terminal', reason: 'cancelled' });
  } finally { opened.store.close(); }
  vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  const cancelled = await inspectSession(f, 'a'), lost = await inspectSession(f, 'b');
  expect(cancelled).not.toHaveProperty('progression');
  expect(lost.progression).toMatchObject({ state: 'blocked', reason: 'RUN_PROGRESSION_REPROPOSE_REQUIRED', session: 'ineligible' });
  for (const locale of ['en', 'tr'] as const) {
    const direction = locale === 'en' ? 'cancel this Run and propose it again' : 'bu işi iptal edip servis üzerinden yeniden önerin';
    for (const inspected of [cancelled, lost]) {
      const texts: string[] = [], runId = inspected.run!.runId;
      for (const args of [['run', 'inspect', '--scope', 's', '--id', runId], ['run', 'list', '--scope', 's']]) {
        const output: string[] = [];
        const code = await main([...args, '--lang', locale], { root: f.project, env: { ...f.env, NO_COLOR: '1' }, initialize() {}, stdin: { isTTY: false },
          stdout: { write(value: string) { output.push(value); return true; } }, stderr: { write() { return true; } },
          inspectRun: async () => inspected, inspectSurfaceRunIds: async () => [runId] } as never);
        expect(code).toBe(0); texts.push(output.join(''));
      }
      const report = { platform: process.platform, host: { cpuCores: 1, totalMemMB: 1024, recommendedMaxWorkers: 1 }, company: { companyId: 'default' },
        principal: { id: f.actor.id }, secretStore: null, imageRefresh: null, installationBinding: null };
      const checks = doctorChecks(report, { scopeId: 's', toolchainsRequested: false, identityProfile: null, backupPassphraseStored: null,
        retiringModels: null, poolStatus: 'ready', toolchainUpdateEnabled: false, progressionRuns: [{ run: inspected.run!, ...(inspected.progression ? { progression: inspected.progression } : {}) }] }, locale);
      const progressionCheck = checks.find(row => row.id === 'work.progression');
      if (inspected === cancelled) expect(progressionCheck).toBeUndefined();
      texts.push(progressionCheck?.text ?? '');
      if (inspected === cancelled) for (const text of texts) {
        expect(text).not.toContain(locale === 'en' ? 'automatic progression is unknown' : 'otomatik ilerleme durumu bilinmiyor');
        expect(text).not.toContain(locale === 'en' ? 'Inspect again for the current cause and next step:' : 'Güncel neden ve sonraki adım için yeniden inceleyin:');
      }
      for (const text of texts) if (inspected === cancelled) expect(text).not.toContain(direction); else expect(text).toContain(direction);
    }
  }
});

it.skipIf(process.platform === 'win32')('119-C4 rev2 point 2a: evaluating with a retained patch and only recover-output missing gives no blocker or upgrade (EN/TR)', async () => {
  const f = await fixture(2, true, true, true), ai = withMcpPrincipal(readLocalOsIdentity);
  const policyPath = productResourcePath(f.layout, 'policy'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const principals = [{ issuer: ai.issuer, subject: ai.subject }];
  policy.grants.push({ id: 'ai-run', effect: 'allow', actions: ['inspect', 'reserve', 'cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'ai-attempt', effect: 'allow', actions: ['execute', 'evaluate', 'read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } });
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const opened = await openConfiguredAttemptStore(f.project, { env: f.env });
  try {
    const initial = (await opened.store.loadRun('s', 'a'))!, identity = { ...initial.identity, taskId: 't', attemptId: 'evaluated-a', generation: 1 };
    await opened.store.reserveRunTasks({ actor: { id: ai.id, issuer: ai.issuer, subject: ai.subject }, scopeId: 's', runId: 'a', commandId: 'reserve-evaluation', expectedRevision: initial.revision, now: 1, identities: [identity] });
    const claim = { request: { protocolVersion: 1 as const, identity, workspace: '/fixture', argv: ['fixture'] }, owner: 'fixture' };
    await opened.store.claimDispatch(dispatchAdmission(claim, dockerDispatchProfile()));
    await opened.store.grantLaunch({ claim, principal: { ...ai, scopeIds: ['s'] }, now: 2 });
    await opened.store.finishDispatch(claim, { handle: identity.attemptId, exitCode: 0, interrupted: false });
    expect((await opened.store.loadRun('s', 'a'))!.progress[0]!.phase).toBe('evaluating');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const conditional = await inspectSession(f, 'a');
    await opened.store.retainDispatchPatch(claim, { schemaVersion: 1, scopeId: 's', digest: 'b'.repeat(64), byteLength: 1 });
    const inspected = await inspectSession(f, 'a');
    expect(inspected.progression!.missing).toEqual([]); expect(inspected.progression!.state).not.toBe('blocked');
    for (const locale of ['en', 'tr'] as const) expect(runProgressionLines(inspected.run!, inspected.progression, locale).join('\n')).not.toContain('--only ai-execution');
    expect(conditional.progression).toMatchObject({ state: 'unknown', reason: 'RUN_PROGRESSION_EVALUATION_UNVERIFIED', missing: [] });
    for (const locale of ['en', 'tr'] as const) {
      const text = runProgressionLines(conditional.run!, conditional.progression, locale).join('\n');
      expect(text).toContain(locale === 'en' ? 'Patch preparation may need additional permission' : 'Yama hazırlamak ek izin gerektirebilir');
      expect(text).not.toContain('--only ai-execution');
    }
  } finally { opened.store.close(); }
});

it.skipIf(process.platform === 'win32')('119-C4 rev2 point 2b: maintenance reports the AI actor Run inspect refusal to an authorized person', async () => {
  const f = await fixture(2, true, true), ai = withMcpPrincipal(readLocalOsIdentity);
  const policyPath = productResourcePath(f.layout, 'policy'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  policy.grants.push({ id: 'ai-membership', effect: 'allow', actions: ['evaluate'], scopes: ['s'], principals: [{ issuer: ai.issuer, subject: ai.subject }], resource: { kind: 'attempt', ids: 'all' } });
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  await personCustody({ ...f, actor: ai }, 'a');
  const inspected = await inspectSession(f, 'a');
  expect(inspected.progression).toMatchObject({ state: 'maintenance-only', actorClass: 'ai', actor: { id: ai.id },
    missing: expect.arrayContaining([{ kind: 'run', id: 'a', action: 'inspect', scope: 's', reason: 'NO_GRANT', code: 'POLICY_DENIED' }]) });
});

it.skipIf(process.platform === 'win32')('119-C4 rev2 point 3: failed maintaining-person context read withholds actor and policy revision (EN/TR)', async () => {
  const f = await fixture(2, true, true); await personCustody(f, 'a');
  const ai = withMcpPrincipal(readLocalOsIdentity), policyPath = productResourcePath(f.layout, 'policy'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  policy.grants.push({ id: 'ai-read', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: ai.issuer, subject: ai.subject }], resource: { kind: 'run', ids: 'all' } });
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const load = scopedRequest.loadConfiguredScopeContext;
  let personReads = 0;
  vi.spyOn(scopedRequest, 'loadConfiguredScopeContext').mockImplementation(async (...args) => {
    // The caller is verified; later person reads, including selected maintenance context, fail.
    if (localPrincipalChannel() !== 'mcp' && ++personReads > 1) throw ErrorRegistry.createError('POLICY_DENIED');
    return load(...args);
  });
  const inspected = await inspectSession(f, 'a');
  expect(personReads).toBe(3);
  expect(inspected.progression).toMatchObject({ state: 'unknown', actorClass: 'person', reason: 'POLICY_DENIED', missing: [] });
  expect(inspected.progression).not.toHaveProperty('actor'); expect(inspected.progression).not.toHaveProperty('policyRevision');
  for (const locale of ['en', 'tr'] as const) {
    const text = runProgressionLines(inspected.run!, inspected.progression, locale).join('\n');
    expect(text).not.toContain(withMcpPrincipal(readLocalOsIdentity).id); expect(text).not.toContain('concurrent-test');
    expect(text).not.toContain('--only ai-execution');
  }
});

it.skipIf(process.platform === 'win32')('119-C1 F4: due leaves old unlaunched AI untouched and expires started person custody as that person', async () => {
  const f = await fixture(2, true, true); await personCustody(f, 'b');
  const opened = await openConfiguredAttemptStore(f.project, { env: f.env }), controller = new AbortController(), reports: string[] = [];
  const execute = vi.spyOn(execution, 'executeConfiguredTask'), reserve = vi.spyOn(runs, 'reserveConfiguredRunTasks');
  try {
    const ai = withMcpPrincipal(readLocalOsIdentity), policyPath = productResourcePath(f.layout, 'policy'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy.grants.push({ id: 'ai-maintenance', effect: 'allow', actions: ['inspect', 'cancel'], scopes: ['s'], principals: [{ issuer: ai.issuer, subject: ai.subject }], resource: { kind: 'run', ids: 'all' } });
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
    for (const runId of ['a', 'b']) {
      const run = (await opened.store.loadRun('s', runId))!;
      await opened.store.commitRunLifecycle({ schemaVersion: 1, scopeId: 's', runId, commandId: `park-${runId}`, expectedRevision: run.revision, actor: f.actor,
        now: 1, timeoutMs: 1, ...(runId === 'a' ? { action: 'park-progression' as const, failureCode: 'POLICY_DENIED' } : { action: 'park-task' as const, taskId: 't', reason: 'evaluation-unknown' as const }) }, () => {});
    }
    const before = await opened.store.loadRun('s', 'a');
    const loop = await prepareConfiguredRunRuntime(f.project, { onError(query, error) { reports.push(`${query?.runId}:${error.code}`); } }, work => work(), { env: f.env });
    const work = loop.run(controller.signal);
    try {
      await expect.poll(() => lifecycleReceipts(opened.path).filter(value => value.action === 'expire'), { timeout: hostBound(3000) }).toEqual([
        expect.objectContaining({ runId: 'b', actor: expect.objectContaining({ id: f.actor.id, issuer: f.actor.issuer, subject: f.actor.subject }) }),
      ]);
      expect(reports).toContain('a:RUN_PROGRESSION_REPROPOSE_REQUIRED');
      expect(await opened.store.loadRun('s', 'a')).toEqual(before);
      expect((await opened.store.loadRun('s', 'b'))?.state).toEqual({ kind: 'terminal', outcome: 'failed', reason: 'park-timeout' });
      expect(execute).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    } finally { controller.abort(); await work; }
  } finally { opened.store.close(); }
});

it.skipIf(process.platform === 'win32')('119-C1 F4: old AI admission parks a failing maintenance turn under its started person grant', async () => {
  const f = await fixture(2, true, true); await personCustody(f, 'a');
  const controller = new AbortController(), attention = deferred(), actors: string[] = [];
  vi.spyOn(runs, 'evaluateConfiguredTask').mockImplementation(async () => { actors.push(readLocalOsIdentity().id); throw ErrorRegistry.createError('POLICY_DENIED'); });
  const execute = vi.spyOn(execution, 'executeConfiguredTask'), reserve = vi.spyOn(runs, 'reserveConfiguredRunTasks');
  const loop = await prepareConfiguredRunRuntime(f.project, { onError(query, error) {
    if (query?.runId === 'a' && error.code === 'RUN_PROGRESSION_PARKED') attention.resolve();
  } }, work => work(), { env: f.env });
  const work = loop.run(controller.signal);
  try {
    await bounded(attention.promise);
    expect(actors).toEqual([f.actor.id, f.actor.id]);
    const opened = await openConfiguredAttemptStore(f.project, { env: f.env });
    try { expect(lifecycleReceipts(opened.path).filter(value => value.action === 'park-progression')).toEqual([
      expect.objectContaining({ runId: 'a', actor: expect.objectContaining({ id: f.actor.id, issuer: f.actor.issuer, subject: f.actor.subject }) }),
    ]); } finally { opened.store.close(); }
    expect(execute).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  } finally { controller.abort(); await work; }
});

it.skipIf(process.platform === 'win32')('119-C1 F3: person policy denial retains the configured failure threshold and backoff', async () => {
  const f = await fixture(2, true), controller = new AbortController(), attention = deferred(), failures: number[] = [];
  vi.spyOn(execution, 'executeConfiguredTask').mockImplementation(async (_root, identity) => {
    if (identity.runId === 'a') { failures.push(Date.now()); throw ErrorRegistry.createError('POLICY_DENIED'); }
    return undefined as never;
  });
  const loop = await prepareConfiguredRunRuntime(f.project, { onError(query, error) {
    if (query?.runId === 'a' && error.code === 'RUN_PROGRESSION_PARKED') attention.resolve();
  } }, work => work(), { env: f.env });
  const work = loop.run(controller.signal);
  try {
    await bounded(attention.promise);
    expect(failures).toHaveLength(2);
    expect(failures[1]! - failures[0]!).toBeGreaterThanOrEqual(100);
    const opened = await openConfiguredAttemptStore(f.project, { env: f.env });
    try { expect((await opened.store.loadRun('s', 'a'))?.state).toMatchObject({ kind: 'parked', failureCode: 'POLICY_DENIED' }); }
    finally { opened.store.close(); }
  } finally { controller.abort(); await work; }
});
