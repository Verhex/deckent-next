import { performance } from 'node:perf_hooks';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { arch, cpus, hostname, platform, release, tmpdir, totalmem, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConfiguredRuntimeClient } from '../../../src/index.js';
import { followLedgerSurface } from '../../../src/composition/core/monitor/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { ensureConfiguredTerminalIdentity } from '#composition/core/scoped-request/index.js';
import { createWorklineLedgerPorts } from '#surfaces/core/cli/index.js';
import { acceptSurfaceEvent, openSurfacePush, releaseSurfacePush, type SurfacePushEvent } from '#surfaces/core/terminal-kit/index.js';
import { clearConfigCache, productResourcePath, t } from '#platform/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { startTestRuntimeService, stopTestRuntimeService } from '../support/runtime-service.js';
import { latencySample, readLatencyClock, summarizeLatency } from '../support/latency-metrics.js';

beforeEach(context => { if (process.platform === 'win32') context.skip('Local OS identity requires POSIX UID'); });
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };

async function project(initializeIdentity = true) {
  const root = await mkdtemp(join(tmpdir(), 'dk-s18b-')); roots.push(root);
  const folder = join(root, 'project'); const data = join(root, 'data');
  await mkdir(join(folder, '.deckent'), { recursive: true });
  const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') };
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(folder, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, inspection: { workers: { heartbeatMs: 100 } }, admission: {
    poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: fixtureDockerRegistry(['selected']),
  }, cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
  cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 }, service: {
    inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000,
  } }));
  const opened = await openConfiguredAttemptStore(folder, { env });
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'output', effect: 'allow', actions: ['read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'approval', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'approval', ids: ['s'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
  ] }), { mode: 0o600 });
  const ledger = opened.path;
  opened.store.close();
  if (initializeIdentity) await ensureConfiguredTerminalIdentity(folder, 's', { env });
  return { folder, env, ledger, policy: productResourcePath(opened.layout, 'policy') };
}

async function openedFollow(folder: string, env: NodeJS.ProcessEnv) {
  const controller = new AbortController();
  let ready!: () => void;
  const opened = new Promise<void>(resolve => { ready = resolve; });
  const iterator = followLedgerSurface(folder, 's', { env }, controller.signal, ready)[Symbol.asyncIterator]();
  const start = await iterator.next();
  expect(start.value).toEqual({ control: 'start', scopeId: 's', cursors: { approval: 0, run: 0, worker: 0 } });
  await opened;
  const first = iterator.next();
  return { controller, iterator, first };
}

it('binds the production follow to the ledger publications and skips another scope', async () => {
  const f = await project();
  const followEvents = (signal: AbortSignal) => followLedgerSurface(f.folder, 's', { env: f.env }, signal);
  const ports = createWorklineLedgerPorts({ root: f.folder, scopeId: 's', options: { env: f.env },
    async inspectWorkers() { throw new Error('unused'); }, async inspectRun() { return null; }, followEvents });
  expect(typeof ports?.followEvents).toBe('function');
  const live = await openedFollow(f.folder, f.env);
  const db = new DatabaseSync(f.ledger);
  try {
    db.prepare('INSERT INTO approval_outbox(scope_id,approval_id,revision,snapshot) VALUES(?,?,?,?)').run('other', 'foreign', 0, '{}');
    db.prepare('INSERT INTO approval_outbox(scope_id,approval_id,revision,snapshot) VALUES(?,?,?,?)').run('s', 'a1', 0, '{}');
    const approval = await live.first;
    expect(approval.value).toMatchObject({ kind: 'approval', scopeId: 's', sequence: 1, id: 'a1', text: 'approval:a1' });
    db.prepare('INSERT INTO worker_event_logs(scope_id,attempt_id,record) VALUES(?,?,?)').run('s', 'attempt-1', '{}');
    db.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?)').run('s', 'run-1', 1, '{}', '{}');
    const worker = await live.iterator.next();
    const run = await live.iterator.next();
    expect(worker.value).toMatchObject({ kind: 'worker', scopeId: 's', sequence: 1, id: 'attempt-1' });
    expect(run.value).toMatchObject({ kind: 'run', scopeId: 's', sequence: 1, id: 'run-1' });
    db.prepare('UPDATE runs SET revision=? WHERE scope_id=? AND run_id=?').run(4, 's', 'run-1');
    const jumped = await live.iterator.next();
    expect(jumped.value).toMatchObject({ kind: 'run', sequence: 4, id: 'run-1' });
  } finally { db.close(); live.controller.abort(); await live.iterator.return(); }
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] the production follow sees a run the runtime service committed', async () => {
  const f = await project();
  await ensureConfiguredTerminalIdentity(f.folder, 's', { env: f.env });
  const service = await startTestRuntimeService(f.folder, f.env);
  const client = createConfiguredRuntimeClient(f.folder, { env: f.env });
  const live = await openedFollow(f.folder, f.env);
  try {
    await client.createRun({ schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph });
    const event = await live.first;
    expect(event.value).toMatchObject({ kind: 'run', scopeId: 's', id: 'r', sequence: 1, text: 'run:r' });
  } finally { live.controller.abort(); await live.iterator.return(); await stopTestRuntimeService(service); }
});

it.skipIf(process.platform !== 'linux' || !process.env['S18B_LATENCY_OUTPUT'])('measures event production to surface on an isolated runtime', async () => {
  const output = process.env['S18B_LATENCY_OUTPUT'];
  if (!output) return;
  const f = await project();
  await ensureConfiguredTerminalIdentity(f.folder, 's', { env: f.env });
  const service = await startTestRuntimeService(f.folder, f.env);
  const client = createConfiguredRuntimeClient(f.folder, { env: f.env });
  const live = await openedFollow(f.folder, f.env);
  const warmup = 5;
  const expected = 50;
  const samples = [];
  let state = openSurfacePush();
  let pending = live.first;
  try {
    for (let n = 1; n <= warmup + expected; n += 1) {
      const now = () => performance.now();
      const start = readLatencyClock(now);
      await client.createRun({ schemaVersion: 1, commandId: `c${n}`, scopeId: 's', runId: `r${n}`, graph });
      const got = await pending;
      if (n < warmup + expected) pending = live.iterator.next();
      const event = got.value as SurfacePushEvent;
      const step = acceptSurfaceEvent(state, event, 's', 5);
      if (step.status === 'applied') state = releaseSurfacePush(step.state);
      else throw new Error(`S18B_MEASURE_STEP_${step.status}`);
      const sample = latencySample(start, readLatencyClock(now));
      if (n > warmup) samples.push(sample);
    }
  } finally { live.controller.abort(); await live.iterator.return(); await stopTestRuntimeService(service); }
  const summary = summarizeLatency(samples, expected);
  const report = {
    schemaVersion: 1, metric: 'eventToSurface', status: summary.status, samples: summary.samples, invalid: summary.invalid,
    missing: summary.missing, p50Ms: summary.p50Ms, p95Ms: summary.p95Ms,
    environment: { node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length, memoryBytes: totalmem(), runtime: 'isolated local runtime service (temp project, not the live install)',
      model: 'not called; the event is a run row committed by the service', tty: 'none (acceptSurfaceEvent, no screen)',
      maxWorkers: process.env['VITEST_MAX_FORKS'] ?? 'unknown', CI: process.env['CI'] ?? null },
    workload: { id: 'S18B-runtime-run-create-v1', samples: expected, warmup, scopeId: 's' },
    clock: 'node:perf_hooks performance.now; from createRun call to acceptSurfaceEvent',
    percentile: 'S00 nearest rank via summarizeLatency; warmup excluded',
    target: { eventToHumanSurfaceP95Ms: 500, status: 'target; not acceptance',
      p95WithinTarget: summary.p95Ms !== null && summary.p95Ms < 500 },
    limits: ['isolated local service and a temp ledger; not the live install and not a provider call',
      'surface step is acceptSurfaceEvent, not a physical terminal paint',
      '500 ms p95 remains the owner target and is not a pass condition'],
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  expect(summary.status).toBe('measured');
  expect(summary.samples).toBe(expected);
});

// A SELECT spy observes the actual native connection, including the opening baseline. Filtering after read cannot pass.
const publications = (calls: readonly (readonly unknown[])[]) => calls.map(args => String(args[0])).filter(sql => /SELECT/i.test(sql) && /\b(approval_outbox|worker_event_logs|runs)\b/.test(sql));
async function changePolicy(f: Awaited<ReturnType<typeof project>>, change: (policy: { grants: { id: string; effect: string; actions: string[]; scopes: string[]; principals: { issuer: string; subject: string }[]; resource: { kind: string; ids: string | string[] } }[] }) => void) {
  const policy = JSON.parse(await readFile(f.policy, 'utf8'));
  change(policy);
  await writeFile(f.policy, JSON.stringify(policy), { mode: 0o600 });
}

it('refuses a different principal before any publication SQL or ready notification', async () => {
  const f = await project();
  await changePolicy(f, policy => { for (const grant of policy.grants) grant.principals = [{ issuer: 'foreign', subject: 'not-this-user' }]; });
  const sql = vi.spyOn(DatabaseSync.prototype, 'prepare'), ready = vi.fn();
  const iterator = followLedgerSurface(f.folder, 's', { env: f.env }, new AbortController().signal, ready);
  expect((await iterator.next()).value).toEqual({ access: 'denied', scopeId: 's', kinds: ['approval', 'run', 'worker'], stopped: true });
  expect(await iterator.next()).toMatchObject({ done: true });
  expect(ready).not.toHaveBeenCalled();
  expect(publications(sql.mock.calls)).toEqual([]);
});

it.each(['other', '../s', ''])('refuses an untrusted scope %j without publication SQL', async scopeId => {
  const f = await project();
  const sql = vi.spyOn(DatabaseSync.prototype, 'prepare');
  const events = [];
  for await (const event of followLedgerSurface(f.folder, scopeId, { env: f.env }, new AbortController().signal)) events.push(event);
  expect(events).toEqual([{ access: 'denied', scopeId, kinds: ['approval', 'run', 'worker'], stopped: true }]);
  expect(publications(sql.mock.calls)).toEqual([]);
});

it.each(['run-only', 'approval-only'] as const)('reads only the granted kinds including the baseline: %s', async mode => {
  const f = await project();
  await changePolicy(f, policy => { policy.grants = policy.grants.filter((grant: { id: string }) => grant.id !== (mode === 'run-only' ? 'approval' : 'output')); });
  const controller = new AbortController(), db = new DatabaseSync(f.ledger);
  const sql = vi.spyOn(DatabaseSync.prototype, 'prepare');
  let ready!: () => void;
  const opened = new Promise<void>(resolve => { ready = resolve; });
  const iterator = followLedgerSurface(f.folder, 's', { env: f.env }, controller.signal, ready);
  try {
    expect((await iterator.next()).value).toEqual({ access: 'denied', scopeId: 's', kinds: mode === 'run-only' ? ['approval'] : ['run', 'worker'], stopped: false });
    expect((await iterator.next()).value).toEqual({ control: 'start', scopeId: 's', cursors: { approval: 0, run: 0, worker: 0 } });
    const next = iterator.next(); await opened;
    for (const scope of ['other', 's']) {
      db.prepare('INSERT INTO approval_outbox(scope_id,approval_id,revision,snapshot) VALUES(?,?,?,?)').run(scope, 'a', 0, '{}');
      db.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?)').run(scope, 'r', 1, '{}', '{}');
      db.prepare('INSERT INTO worker_event_logs(scope_id,attempt_id,record) VALUES(?,?,?)').run(scope, 'w', '{}');
    }
    expect((await next).value).toMatchObject({ kind: mode === 'run-only' ? 'worker' : 'approval', scopeId: 's', sequence: 1 });
    if (mode === 'run-only') expect((await iterator.next()).value).toMatchObject({ kind: 'run', scopeId: 's', sequence: 1 });
    const selected = publications(sql.mock.calls).join(' ');
    expect(selected).not.toContain(mode === 'run-only' ? 'approval_outbox' : 'worker_event_logs');
    if (mode === 'approval-only') expect(selected).not.toMatch(/\bruns\b/);
  } finally { controller.abort(); await iterator.return(); db.close(); }
});

it.each(['revoke-output', 'revoke-approval', 'revoke-scope', 'unreadable-policy', 'change-company'] as const)('stops on the next heartbeat without a ledger write: %s', async change => {
  const f = await project();
  const live = await openedFollow(f.folder, f.env);
  try {
    if (change === 'unreadable-policy') await writeFile(f.policy, '{');
    else if (change === 'change-company') {
      const path = join(f.folder, '.deckent/config.json');
      const config = JSON.parse(await readFile(path, 'utf8')); config.company = { id: 'different-company' };
      await writeFile(path, JSON.stringify(config));
    } else await changePolicy(f, policy => { policy.grants = policy.grants.filter((grant: { id: string }) => change !== 'revoke-scope' && grant.id !== (change === 'revoke-output' ? 'output' : 'approval')); });
    expect((await live.first).value).toMatchObject({ access: 'denied', scopeId: 's', stopped: true });
    expect(await live.iterator.next()).toMatchObject({ done: true });
  } finally { live.controller.abort(); await live.iterator.return(); }
});

it('rechecks between buffered publications so a paused consumer cannot receive revoked rows', async () => {
  const f = await project(); const live = await openedFollow(f.folder, f.env); const db = new DatabaseSync(f.ledger);
  try {
    db.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?)').run('s', 'r1', 1, '{}', '{}');
    db.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?)').run('s', 'r2', 1, '{}', '{}');
    expect((await live.first).value).toMatchObject({ kind: 'run', id: 'r1' });
    await changePolicy(f, policy => { policy.grants = []; });
    expect((await live.iterator.next()).value).toMatchObject({ access: 'denied', stopped: true });
    expect(await live.iterator.next()).toMatchObject({ done: true });
  } finally { live.controller.abort(); await live.iterator.return(); db.close(); }
});

it.each(['deny', 'require-approval', 'single-id'] as const)('does not promote a partial resource grant into collection access: %s', async effect => {
  const f = await project();
  await changePolicy(f, policy => {
    policy.grants = policy.grants.filter((grant: { id: string }) => grant.id !== 'approval');
    const output = policy.grants.find((grant: { id: string }) => grant.id === 'output')!;
    if (effect === 'single-id') output.resource.ids = ['only-one-attempt'];
    else policy.grants.push({ ...output, id: 'restriction', effect, resource: { kind: 'attempt', ids: ['secret-attempt'] } });
  });
  const sql = vi.spyOn(DatabaseSync.prototype, 'prepare');
  const iterator = followLedgerSurface(f.folder, 's', { env: f.env }, new AbortController().signal);
  expect((await iterator.next()).value).toMatchObject({ access: 'denied', stopped: true });
  expect(await iterator.next()).toMatchObject({ done: true });
  expect(publications(sql.mock.calls)).toEqual([]);
});

it.each(['en', 'tr'] as const)('renders a real producer denial in %s without reconnect or fallback reads', async locale => {
  const f = await project(); await changePolicy(f, policy => { policy.grants = []; });
  let calls = 0, polls = 0;
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS,
    watchAccessDenied: t('terminal.workline.watchAccessDenied', {}, locale), watchAccessStopped: t('terminal.workline.watchAccessStopped', {}, locale),
    watchDelivery: t('terminal.workline.watchDelivery', {}, locale) }, pollMs: 5, ledger: { scopeId: 's',
    followEvents: signal => { calls++; return followLedgerSurface(f.folder, 's', { env: f.env }, signal); },
    async listWorkers() { polls++; return { schemaVersion: 1, scopeId: 's', sources: [], observedAt: 0, control: 'observe-only' }; },
    async listRunIds() { polls++; return []; }, async listApprovalPage() { polls++; return []; }, async inspectRun() { polls++; return null; },
  } });
  try {
    const denied = t('terminal.workline.watchAccessStopped', { kinds: 'approval, run, worker' }, locale);
    await until(() => view.stdout.text.includes(denied), 'localized access refusal');
    for (const char of '/watch-workers\r') { view.stdin.write(char); await settle(2); }
    await settle(50);
    expect(calls).toBe(1); expect(polls).toBe(0);
    expect(view.stdout.text).toContain(t('terminal.workline.watchDelivery', { mode: 'denied', timeoutMs: 5, owner: 'terminal-watch', action: 'refuse-scope' }, locale));
    expect(view.stdout.text).not.toContain('poll-scope');
    expect(view.stdout.text).not.toMatch(/\{(?:kinds|mode|status)\}/);
  } finally { view.instance.unmount(); }
});

it('honors v2 role bindings and revocation without a policy revision change', async () => {
  const f = await project();
  const parsed = JSON.parse(await readFile(f.policy, 'utf8'));
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(f.policy, JSON.stringify({ schemaVersion: 2, revision: 'roles', grants: [parsed.grants.find((g: { id: string }) => g.id === 'scope')], restrictions: [], separationOfDuties: [],
    roles: [{ id: 'reader', permissions: [
      { id: 'output', effect: 'allow', actions: ['read-output'], resource: { kind: 'attempt', ids: 'all' } },
      { id: 'approval', effect: 'allow', actions: ['inspect'], resource: { kind: 'approval', ids: 'all' } },
    ] }] }), { mode: 0o600 });
  const bindings = join(f.policy, '..', 'bindings.json');
  await writeFile(bindings, JSON.stringify({ schemaVersion: 1, revision: 'roles', bindings: [{ id: 'self', principals, scopes: ['s'], roles: ['reader'] }] }), { mode: 0o600 });
  const live = await openedFollow(f.folder, f.env);
  try {
    await writeFile(bindings, JSON.stringify({ schemaVersion: 1, revision: 'roles', bindings: [] }), { mode: 0o600 });
    expect((await live.first).value).toMatchObject({ access: 'denied', stopped: true });
    expect(await live.iterator.next()).toMatchObject({ done: true });
  } finally { live.controller.abort(); await live.iterator.return(); }
});

it('refuses a scope pinned to another company before publication SQL', async () => {
  const f = await project(); const db = new DatabaseSync(f.ledger);
  db.prepare('INSERT INTO companies(company_id) VALUES(?)').run('foreign-company');
  db.prepare('UPDATE scope_registry SET company_id=? WHERE scope_id=?').run('foreign-company', 's');
  db.close();
  const sql = vi.spyOn(DatabaseSync.prototype, 'prepare');
  const iterator = followLedgerSurface(f.folder, 's', { env: f.env }, new AbortController().signal);
  expect((await iterator.next()).value).toEqual({ access: 'denied', scopeId: 's', kinds: ['approval', 'run', 'worker'], stopped: true });
  expect(await iterator.next()).toMatchObject({ done: true });
  expect(publications(sql.mock.calls)).toEqual([]);
});

it('cancels an idle follow without a denial and closes its tail', async () => {
  const f = await project(); const live = await openedFollow(f.folder, f.env);
  const closes = vi.spyOn(DatabaseSync.prototype, 'close');
  live.controller.abort();
  expect(await live.first).toMatchObject({ done: true });
  expect(closes).toHaveBeenCalled();
});

it('closes the publication connection before reporting a revoked follow', async () => {
  const f = await project(); const live = await openedFollow(f.folder, f.env); const db = new DatabaseSync(f.ledger);
  try {
    db.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?)').run('s', 'r', 1, '{}', '{}');
    expect((await live.first).value).toMatchObject({ kind: 'run', id: 'r' });
    await changePolicy(f, policy => { policy.grants = []; });
    // No grant means even the scope registry is unopened. The only close is the existing publication tail.
    const closes = vi.spyOn(DatabaseSync.prototype, 'close');
    expect((await live.iterator.next()).value).toMatchObject({ access: 'denied', stopped: true });
    expect(closes).toHaveBeenCalledTimes(1);
  } finally { live.controller.abort(); await live.iterator.return(); db.close(); }
});


it.each(['en', 'tr'] as const)('renders missing identity in %s and stops without reconnect, snapshot or polling', async locale => {
  const f = await project(false);
  const follow = vi.fn((signal: AbortSignal) => followLedgerSurface(f.folder, 's', { env: f.env }, signal));
  const read = vi.fn(async () => ({ scopeId: 's', denied: [] }));
  const poll = vi.fn(async () => []);
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS,
    watchNotInitialized: t('terminal.workline.watchNotInitialized', {}, locale),
    watchAccessStopped: t('terminal.workline.watchAccessStopped', {}, locale),
    watchDelivery: t('terminal.workline.watchDelivery', {}, locale) }, pollMs: 5, ledger: { scopeId: 's',
    followEvents: follow, readSurfaceSnapshot: read, listRunIds: poll, listApprovalPage: poll,
  } });
  try {
    await until(() => view.stdout.text.includes(t('terminal.workline.watchNotInitialized', {}, locale)), 'missing identity notice');
    expect(view.stdout.text).toContain(t('terminal.workline.watchNotInitialized', {}, locale));
    for (const command of ['/watch-workers\r', '/watch-stop\r', '/watch-runs\r']) {
      for (const char of command) { view.stdin.write(char); await settle(2); }
    }
    await settle(50);
    expect(follow).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled(); expect(poll).not.toHaveBeenCalled();
    expect(view.stdout.text).toContain(t('terminal.workline.watchDelivery', { mode: 'not-initialized', timeoutMs: 5, owner: 'terminal-watch', action: 'refuse-scope' }, locale));
    expect(view.stdout.text).not.toContain('poll-scope');
    expect(view.stdout.text).not.toContain(t('terminal.workline.watchAccessStopped', { kinds: 'approval, run, worker' }, locale));
  } finally { view.instance.unmount(); }
});
