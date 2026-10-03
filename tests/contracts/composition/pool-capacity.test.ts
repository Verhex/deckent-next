import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it, type TestContext } from 'vitest';
import { applyPoolCapacity, inspectPoolCapacity, applyPoolHold, inspectPoolHold, inspectRun } from '../../../src/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { clearConfigCache, resolveGlobalScopePaths } from '#platform/index.js';
import { main } from '#surfaces/core/cli/index.js';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';
import { readMonitorLedger, registerProviderConfig } from '#adapters/index.js';
import { decidePoolCapacity, projectMonitorRun, poolCapacityCommandSchema } from '#engine/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
async function fixtureConfig() {
  registerProviderConfig();
  const root = await mkdtemp(join(tmpdir(), 'dn-pool-capacity-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal: { scopeId: 's' }, admission: { poolId: 'p',
    executionSlots: 8, inFlightSlots: 8, ordering: 'input-order', registry: fixtureDockerRegistry(['selected']) } }));
  const home = join(root, 'home'), env = { HOME: home, USERPROFILE: home };
  return { project, data, env, options: { env } };
}
async function fixture(context: TestContext, scopes: 'all' | string[] = 'all') {
  const { project, data, env, options } = await fixtureConfig();
  if (process.platform === 'win32') {
    await expect(openConfiguredAttemptStore(project, options)).rejects.toMatchObject({ code: 'MANAGED_FILE_UNSUPPORTED' });
    await expect(stat(data)).rejects.toMatchObject({ code: 'ENOENT' });
    context.skip('MANAGED_FILE_UNSUPPORTED: private managed ledger requires POSIX; refusal before storage effects verified');
  }
  const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } }); opened.store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const policy = async (controlScopes: 'all' | string[]) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool-use', effect: 'allow', actions: ['use', 'inspect'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'pool-control', effect: 'allow', actions: ['hold', 'resume', 'set-capacity'], scopes: controlScopes, principals, resource: { kind: 'pool', ids: ['p'] } },
  ] }), { mode: 0o600 }); await policy(scopes);
  const rows = (sql: string) => { const db = new DatabaseSync(opened.path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const cli = async (argv: string[]) => {
    let out = '', err = '';
    const code = await main(argv, { root: project, env, initialize() {}, stdout: { write(text) { out += text; } }, stderr: { write(text) { err += text; } },
      applyPoolCapacity, inspectPoolCapacity, applyPoolHold, inspectPoolHold, inspectRun });
    return { code, out, err };
  };
  const create = (runId: string) => createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId, commandId: 'create-' + runId, graph }, options);
  const reserve = (runId: string) => reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId, commandId: 'reserve-' + runId, expectedRevision: 0 }, options);
  return { project, options, rows, cli, create, reserve, path: opened.path, policy };
}
const command = (id: string, executionSlots = 8, inFlightSlots = executionSlots) => ({ schemaVersion: 1 as const, scopeId: 's', commandId: id, capacity: { executionSlots, inFlightSlots } });

it('resolves Windows fixture home and refuses managed storage before effects (native Windows or platform-property simulation)', async () => {
  const f = await fixtureConfig(), original = Object.getOwnPropertyDescriptor(process, 'platform')!, platform = process.platform;
  // On a POSIX host keep native path/config parsing; simulate only the managed-port capability branch.
  const home = platform === 'win32' ? f.env.USERPROFILE : 'C:\\fixture\\home';
  expect(resolveGlobalScopePaths('win32', { HOME: f.env.HOME, USERPROFILE: home }).home).toBe(home);
  expect(() => resolveGlobalScopePaths('win32', { HOME: f.env.HOME })).toThrow(expect.objectContaining({ code: 'HOME_NOT_RESOLVED' }));
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try {
    await expect(openConfiguredAttemptStore(f.project, { ...f.options, platform })).rejects.toMatchObject({ code: 'MANAGED_FILE_UNSUPPORTED' });
    await expect(stat(f.data)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { Object.defineProperty(process, 'platform', original); }
});

it('shows drift and typed waits without writes, raises 2/2 to 8/8 and allows eight independent reservations; shows actor/time receipt and refuses shrink', async context => {
  const f = await fixture(context);
  for (let i = 0; i < 8; i++) await f.create('r' + i);
  await f.reserve('r0'); await f.reserve('r1');
  await expect(f.reserve('r2')).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
  const before = await readFile(f.path), receipts = f.rows('SELECT count(*) AS n FROM run_receipts');
  const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r2' };
  for (let i = 0; i < 3; i++) expect((await inspectRun(f.project, query, f.options)).run?.pool).toMatchObject({ capacity: { executionSlots: 2, inFlightSlots: 2 },
    drift: [{ code: 'POOL_ADMISSION_CAPACITY_DRIFT', source: 'run' }, { source: 'admission' }],
    waiting: [{ taskId: 't', reason: { code: 'waiting-pool-slot', poolId: 'p', occupancy: { execution: 2, inFlight: 2 }, sinceMs: null } }] });
  expect(await readFile(f.path)).toEqual(before); expect(f.rows('SELECT count(*) AS n FROM run_receipts')).toEqual(receipts);
  expect(await f.cli(['run', 'inspect', '--id', 'r2', '--scope', 's', '--lang', 'tr'])).toMatchObject({ code: 0, out: expect.stringContaining('doluluk 2/2') });
  const doctor = await f.cli(['doctor', '--json']); expect(doctor.code).toBe(0); expect(JSON.parse(doctor.out)).toMatchObject({ status: 'degraded', poolReadiness: { status: 'drift', drift: { code: 'POOL_ADMISSION_CAPACITY_DRIFT' } } });
  const resized = await f.cli(['pool', 'set-capacity', '--execution-slots', '8', '--in-flight-slots', '8', '--command-id', 'resize', '--json']);
  expect(resized.code).toBe(0); const receipt = JSON.parse(resized.out);
  expect(receipt).toMatchObject({ changed: true, previous: { executionSlots: 2, inFlightSlots: 2 }, next: { executionSlots: 8, inFlightSlots: 8 }, actor: { issuer: hostname(), subject: String(userInfo().uid) }, atMs: expect.any(Number) });
  expect(await applyPoolCapacity(f.project, { ...command('resize'), poolId: 'p' }, f.options)).toEqual(receipt);
  await expect(applyPoolCapacity(f.project, command('resize', 9), f.options)).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
  expect((await inspectRun(f.project, query, f.options)).run?.pool).toMatchObject({ drift: [], waiting: [] });
  expect(JSON.parse((await f.cli(['pool', 'status', '--json'])).out)).toMatchObject({ capacity: { receipt } });
  expect(await f.cli(['doctor', '--lang', 'tr'])).toMatchObject({ code: 0, out: expect.stringContaining('Havuz hazırlığı') });
  expect(await f.cli(['pool', 'status', '--lang', 'tr'])).toMatchObject({ out: expect.stringContaining('kapasite 8/8') });
  for (let i = 2; i < 8; i++) await f.reserve('r' + i);
  expect(await inspectPoolCapacity(f.project, { schemaVersion: 1, scopeId: 's' }, f.options)).toMatchObject({ occupancy: { execution: 8, inFlight: 8 }, receipt });
  expect(await applyPoolCapacity(f.project, command('equal'), f.options)).toMatchObject({ changed: false });
  const original = f.rows('SELECT policy FROM execution_pools');
  await expect(applyPoolCapacity(f.project, command('shrink', 7), f.options)).rejects.toMatchObject({ code: 'RUN_POOL_CAPACITY_OCCUPIED' });
  expect(f.rows('SELECT policy FROM execution_pools')).toEqual(original);
  expect(f.rows('SELECT count(*) AS n FROM execution_pool_capacity_receipts')).toEqual([{ n: 2 }]);
  const reading = await readMonitorLedger(f.path, { busyTimeoutMs: 1000, maxRuns: 100 });
  expect(reading.pools[0]).toMatchObject({ executionSlots: 8, inFlightSlots: 8, execution: 8, inFlight: 8 });
});

it('shares SDK, MCP and CLI installation authority; refuses scoped-only authority and foreign scope; no persona grant', async context => {
  const f = await fixture(context, ['s']);
  await expect(applyPoolCapacity(f.project, command('sdk-denied'), f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(await f.cli(['pool', 'set-capacity', '--execution-slots', '8', '--in-flight-slots', '8'])).toMatchObject({ code: 1, err: expect.stringContaining('POLICY_DENIED') });
  await expect(applyPoolCapacity(f.project, { ...command('foreign'), scopeId: 'foreign' }, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    applyPoolCapacity: value => applyPoolCapacity(f.project, value, f.options), inspectPoolCapacity: value => inspectPoolCapacity(f.project, value, f.options) } as McpApplications,
  { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); const client = new Client({ name: 'pool-capacity-test', version: '1' }); await client.connect(ct);
  try {
    expect(JSON.stringify(await client.callTool({ name: 'apply_pool_capacity', arguments: command('mcp-denied') }))).toContain('POLICY_DENIED');
    await f.policy('all');
    const result = await client.callTool({ name: 'apply_pool_capacity', arguments: command('mcp-ok') }); expect(result.structuredContent).toMatchObject({ changed: true, next: { executionSlots: 8 } });
    expect((await client.callTool({ name: 'inspect_pool_capacity', arguments: { schemaVersion: 1, scopeId: 's' } })).structuredContent).toMatchObject({ capacity: { executionSlots: 8 } });
    expect((await client.callTool({ name: 'apply_pool_capacity', arguments: { ...command('invalid'), capacity: { executionSlots: 0, inFlightSlots: 8 } } })).isError).toBe(true);
  } finally { await client.close(); await server.close(); }
  expect(f.rows('SELECT count(*) AS n FROM execution_pool_capacity_receipts')).toEqual([{ n: 1 }]);
  expect(f.rows("SELECT count(*) AS n FROM audit_events WHERE kind='pool-capacity'")).toEqual([{ n: 4 }]);
});

it('derives a hold wait and clears it on resume in Run and monitor; max_workers ceiling stays explicit', async context => {
  const f = await fixture(context); await f.create('r'); await applyPoolHold(f.project, { schemaVersion: 1, scopeId: 's', commandId: 'h', action: 'hold' }, f.options);
  const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r' }, run = (await inspectRun(f.project, query, f.options)).run!;
  expect(run.pool?.waiting[0]?.reason).toMatchObject({ code: 'pool-held', poolId: 'p', occupancy: { execution: 0, inFlight: 0 }, sinceMs: expect.any(Number) });
  const reading = await readMonitorLedger(f.path, { busyTimeoutMs: 1000, maxRuns: 100 });
  const monitor = projectMonitorRun({ run: reading.runs[0]!, pool: reading.pools[0]!, approvals: [], workers: new Map(), observedAt: Date.now() });
  expect(monitor.blocker).toMatchObject({ code: 'pool-held', pool: run.pool?.waiting[0]?.reason });
  await applyPoolHold(f.project, { schemaVersion: 1, scopeId: 's', commandId: 'resume', action: 'resume' }, f.options);
  expect((await inspectRun(f.project, query, f.options)).run?.pool?.waiting).toEqual([]);
});

it('validates safe positive slots and both occupancy dimensions, including evaluation/uncertain in-flight', () => {
  const actor = { issuer: 'test', subject: 'operator' };
  for (const value of [0, -1, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(poolCapacityCommandSchema.safeParse(command('bad', value)).success).toBe(false);
  expect(poolCapacityCommandSchema.safeParse(command('bound', Number.MAX_SAFE_INTEGER)).success).toBe(true);
  for (const occupancy of [{ execution: 3, inFlight: 1 }, { execution: 0, inFlight: 3 }]) expect(() => decidePoolCapacity({ executionSlots: 8, inFlightSlots: 8 }, occupancy,
    { command: { ...command('shrink', 2), poolId: 'p' }, actor, atMs: 0 })).toThrow(expect.objectContaining({ code: 'RUN_POOL_CAPACITY_OCCUPIED' }));
});

it('rolls back capacity and receipt when audit cannot be recorded; equal replay never records a second audit', async context => {
  const f = await fixture(context), opened = await openConfiguredAttemptStore(f.project, f.options);
  try {
    await expect(opened.store.applyPoolCapacity({ command: { ...command('fail'), poolId: 'p' }, actor: { issuer: 'test', subject: 'operator' }, atMs: 0 }, () => { throw new Error('audit unavailable'); })).rejects.toThrow('audit unavailable');
    expect(await opened.store.readPoolCapacity('p')).toMatchObject({ capacity: { executionSlots: 2 }, receipt: null });
    expect(f.rows('SELECT count(*) AS n FROM execution_pool_capacity_receipts')).toEqual([{ n: 0 }]);
  } finally { opened.store.close(); }
});

it('reports configured max_workers ceiling separately from ledger capacity and changes nothing when inspected', async context => {
  const f = await fixture(context); await f.create('r0'); await f.create('r1'); await f.reserve('r0');
  const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  config.max_workers = 1; await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
  await expect(f.reserve('r1')).rejects.toMatchObject({ code: 'RUN_POOL_FULL' });
  expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r1' }, f.options)).run?.pool).toMatchObject({
    capacity: { executionSlots: 2, inFlightSlots: 2 }, effectiveCapacity: { executionSlots: 1, inFlightSlots: 1 },
    waiting: [{ reason: { code: 'waiting-pool-slot', effectiveCapacity: { executionSlots: 1 } } }] });
});

it('keeps config admission for q out of existing p Run drift; same-pool and pinned drift stay visible with write-free waits', async context => {
  const f = await fixture(context), configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  const configure = async (poolId: string, slots: number) => {
    Object.assign(config.admission, { poolId, executionSlots: slots, inFlightSlots: slots });
    await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
  };
  await configure('p', 2);
  for (const id of ['busy0', 'busy1', 'waiting']) await f.create(id);
  await f.reserve('busy0'); await f.reserve('busy1');
  const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'waiting' };
  const check = async (runId: string, sources: string[]) => {
    const before = await readFile(f.path), receipts = f.rows('SELECT * FROM run_receipts'), audit = f.rows('SELECT * FROM audit_events');
    for (let i = 0; i < 3; i++) {
      const pool = (await inspectRun(f.project, { ...query, runId }, f.options)).run!.pool!;
      expect(pool.poolId).toBe('p'); expect(pool.drift.map(drift => drift.source)).toEqual(sources);
      expect(pool.waiting).toEqual([{ taskId: 't', reason: { code: 'waiting-pool-slot', poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 },
        effectiveCapacity: { executionSlots: 2, inFlightSlots: 2 }, occupancy: { execution: 2, inFlight: 2 }, sinceMs: null } }]);
    }
    expect(await readFile(f.path)).toEqual(before); expect(f.rows('SELECT * FROM run_receipts')).toEqual(receipts); expect(f.rows('SELECT * FROM audit_events')).toEqual(audit);
  };
  await configure('q', 8); await check('waiting', []);
  await configure('p', 8); await check('waiting', ['admission']);
  await f.create('pinned'); await configure('q', 8); await check('pinned', ['run']);
});

it('returns unknown on lost COMMIT acknowledgement; replay resolves the one committed capacity receipt', async context => {
  const f = await fixture(context), opened = await openConfiguredAttemptStore(f.project, f.options), original = DatabaseSync.prototype.exec;
  const write = { command: { ...command('lost-ack'), poolId: 'p' }, actor: { issuer: 'test', subject: 'operator' }, atMs: 0 };
  let committed = false;
  DatabaseSync.prototype.exec = function (sql: string) {
    const result = original.call(this, sql);
    if (!committed && sql === 'COMMIT') { committed = true; throw new Error('lost acknowledgement'); }
    return result;
  };
  try { await expect(opened.store.applyPoolCapacity(write, () => {})).rejects.toMatchObject({ code: 'ATTEMPT_STORE_OUTCOME_UNKNOWN' }); }
  finally { DatabaseSync.prototype.exec = original; }
  try {
    const receipt = await opened.store.applyPoolCapacity(write, () => { throw new Error('replay must not audit twice'); });
    expect(receipt).toMatchObject({ commandId: 'lost-ack', changed: true, next: { executionSlots: 8 } });
    expect(f.rows('SELECT count(*) AS n FROM execution_pool_capacity_receipts')).toEqual([{ n: 1 }]);
  } finally { opened.store.close(); }
});

it('counts another scope occupancy when shrinking and refuses a control restriction in another scope', async context => {
  const f = await fixture(context); await f.create('local'); await f.reserve('local');
  const opened = await openConfiguredAttemptStore(f.project, f.options);
  try {
    const local = (await opened.store.loadRun('s', 'local'))!, actor = { id: 'fixture', issuer: 'test', subject: 'fixture' };
    await opened.store.createRun({ commandId: 'foreign-create', actor, identity: { scopeId: 'other', runId: 'foreign', layoutRevision: local.identity.layoutRevision }, graph,
      execution: local.execution, now: 0, policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 8, inFlightSlots: 8 }, ordering: ['t'] } });
    await opened.store.reserveRunTasks({ commandId: 'foreign-reserve', actor, scopeId: 'other', runId: 'foreign', expectedRevision: 0, now: 0,
      identities: [{ scopeId: 'other', runId: 'foreign', taskId: 't', attemptId: 'foreign-attempt', generation: 1, layoutRevision: local.identity.layoutRevision }] });
  } finally { opened.store.close(); }
  await expect(applyPoolCapacity(f.project, command('shrink-other', 1), f.options)).rejects.toMatchObject({ code: 'RUN_POOL_CAPACITY_OCCUPIED' });
  const path = join(f.project, '../data/policy.json'), policy = JSON.parse(await readFile(path, 'utf8'));
  policy.restrictions = [{ id: 'other-deny', actions: ['set-capacity'], scopes: ['other'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'pool', ids: ['p'] } }];
  await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
  await expect(applyPoolCapacity(f.project, command('restricted'), f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.rows('SELECT count(*) AS n FROM execution_pool_capacity_receipts')).toEqual([{ n: 0 }]);
});
