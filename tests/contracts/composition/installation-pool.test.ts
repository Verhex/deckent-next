import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openLocalIntegrityAuthority, openSqliteAttemptStore, openSqliteAuditStore, openInstallationPoolStore } from '#adapters/index.js';
import { AuditApplication, installExecutionPool } from '#engine/index.js';
import { installConfiguredExecutionPool } from '#composition/core/installation/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { main } from '#surfaces/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const pool = { schemaVersion: 1 as const, poolId: 'configured-pool', capacity: { executionSlots: 4, inFlightSlots: 6 } };
async function fixture(admission: unknown = { ...pool.capacity, poolId: pool.poolId, ordering: 'input-order', registry: {} }) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-init-pool-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(data, { mode: 0o700 });
  const configPath = join(project, '.deckent/config.json');
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, admission }), { mode: 0o600 });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'customer-policy', grants: [], restrictions: [] }), { mode: 0o600 });
  await writeFile(join(data, 'bindings.json'), JSON.stringify({ schemaVersion: 2, revision: 'customer-bindings', bindings: [] }), { mode: 0o600 });
  const options = { platform: process.platform, env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') } }, config = await loadComposedConfig(project, { ...options, heal: false });
  const path = productResourcePath(config.productLayout, 'ledger');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const store = await openSqliteAttemptStore(path, config.storage.sqlite, { now: Date.now, timeoutMs: 60_000 }); store.close(); await chmod(path, 0o600);
  const install = (apply: boolean, uid = process.getuid?.()) => installConfiguredExecutionPool(project, 'customer', apply, options, uid);
  const rows = (sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  return { project, data, configPath, path, config, options, install, rows };
}

it.skipIf(process.platform === 'win32')('custom layout preview leaves bytes/rows/authority unchanged; apply creates the configured row and one sealed event; replay is current', async () => {
  const f = await fixture(), before = await readFile(f.path), policy = await readFile(join(f.data, 'policy.json'));
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
  expect(await f.install(false)).toEqual({ schemaVersion: 1, scopeId: 'customer', status: 'preview', configured: pool });
  expect(exec).not.toHaveBeenCalled();
  expect(await readFile(f.path)).toEqual(before);
  expect(f.rows('SELECT * FROM execution_pools')).toEqual([]); expect(f.rows('SELECT * FROM audit_events')).toEqual([]);
  expect(await stat(join(f.project, '.deckent/ledger.db')).catch(() => null)).toBeNull();
  expect(await f.install(true)).toMatchObject({ status: 'created', configured: pool });
  expect(exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE')).toHaveLength(1);
  expect(f.rows('SELECT pool_id,policy FROM execution_pools')).toEqual([{ pool_id: pool.poolId, policy: JSON.stringify(pool) }]);
  expect(await f.install(true)).toMatchObject({ status: 'current', stored: pool });
  expect(await f.install(false)).toMatchObject({ status: 'current', stored: pool });
  const auditStore = await openSqliteAuditStore(f.path, f.config.storage.sqlite);
  try {
    const integrity = await openLocalIntegrityAuthority(f.config.productLayout, f.config.approvals.keyFile);
    const records = new AuditApplication(auditStore, integrity).list('customer', 0, 100);
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toMatchObject({ scopeId: 'customer', policyRevision: 'customer-policy', principal: { issuer: hostname(), subject: String(userInfo().uid) },
      subject: { kind: 'installation-pool', installer: { basis: 'file-owner' }, poolId: pool.poolId, capacity: pool.capacity } });
    expect(records[0]!.event.subject).not.toHaveProperty('approvalId');
  } finally { auditStore.close(); }
  expect(await readFile(join(f.data, 'policy.json'))).toEqual(policy);
});

it.skipIf(process.platform === 'win32')('a differing stored capacity is a conflict, never overwritten or audited', async () => {
  const f = await fixture(), stored = { ...pool, capacity: { executionSlots: 1, inFlightSlots: 2 } };
  const db = new DatabaseSync(f.path); db.prepare('INSERT INTO execution_pools VALUES(?,?)').run(pool.poolId, JSON.stringify(stored)); db.close();
  const before = await readFile(f.path);
  for (const apply of [false, true]) expect(await f.install(apply)).toMatchObject({ status: 'conflict', reason: 'pool-policy', configured: pool, stored });
  expect(await readFile(f.path)).toEqual(before); expect(f.rows('SELECT * FROM audit_events')).toEqual([]);
});

it.skipIf(process.platform === 'win32')('both modes fail closed for foreign owner or symlinked authority documents without writes', async () => {
  const f = await fixture(), before = await readFile(f.path);
  for (const apply of [false, true]) expect(await f.install(apply, (process.getuid?.() ?? 0) + 1)).toMatchObject({ status: 'unavailable', reason: 'not-owner' });
  await rm(join(f.data, 'bindings.json')); await symlink(join(f.data, 'policy.json'), join(f.data, 'bindings.json'));
  for (const apply of [false, true]) expect(await f.install(apply)).toMatchObject({ status: 'unavailable', reason: 'not-owner' });
  expect(await readFile(f.path)).toEqual(before); expect(f.rows('SELECT * FROM audit_events')).toEqual([]);
});

it.skipIf(process.platform === 'win32').each([0, CURRENT_LEDGER_VERSION - 1, CURRENT_LEDGER_VERSION + 1])('ledger version %i is refused, never migrated or written', async version => {
  const f = await fixture(), db = new DatabaseSync(f.path); db.exec(`PRAGMA user_version=${version}`); db.close();
  const before = await readFile(f.path);
  for (const apply of [false, true]) expect(await f.install(apply)).toMatchObject({ status: 'conflict', reason: 'ledger-version', ledgerVersion: version });
  expect(await readFile(f.path)).toEqual(before); expect(f.rows('SELECT * FROM execution_pools')).toEqual([]);
});

it.skipIf(process.platform === 'win32')('does not recreate a ledger deleted between writer lstat and SQLite open', async () => {
  const f = await fixture(), store = await openInstallationPoolStore(f.path, f.config.storage.sqlite), inspect = store.inspect.bind(store);
  let writer = false;
  store.inspect = async input => { const result = await inspect(input); writer = true; return result; };
  const original = fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const result = await original(...args);
    if (writer && args[0] === f.path) { writer = false; await rm(f.path); }
    return result;
  });
  syncBuiltinESMExports();
  const audit = vi.fn();
  expect(await store.provision(pool, audit)).toMatchObject({ status: 'unavailable', reason: 'ledger-unavailable' });
  expect(audit).not.toHaveBeenCalled(); await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('CLI source surface dispatches through the composed installer to the custom ledger', async () => {
  const f = await fixture(); let output = '';
  expect(await main(['init', 'pool', '--scope', 'customer', '--apply', '--json'], { root: f.project, env: f.options.env,
    installConfiguredExecutionPool: (root, scopeId, apply) => installConfiguredExecutionPool(root, scopeId, apply, f.options),
    stdout: { write(text) { output += text; } } })).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ status: 'created', configured: pool });
  expect(f.rows('SELECT * FROM execution_pools')).toHaveLength(1); expect(f.rows('SELECT * FROM audit_events')).toHaveLength(1);
});

it.skipIf(process.platform === 'win32')('unsupported managed-file platform is unavailable before storage effects (platform-property simulation)', async () => {
  const f = await fixture(), before = await readFile(f.path), original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try { expect(await f.install(false)).toMatchObject({ status: 'unavailable', reason: 'ledger-unavailable' }); }
  finally { Object.defineProperty(process, 'platform', original); }
  expect(await readFile(f.path)).toEqual(before); expect(f.rows('SELECT * FROM execution_pools')).toEqual([]);
});

it.skipIf(process.platform === 'win32')('missing ledger stays missing, and absent/invalid admission returns unavailable without effects', async () => {
  const f = await fixture(); await rm(f.path);
  for (const apply of [false, true]) expect(await f.install(apply)).toMatchObject({ status: 'unavailable', reason: 'ledger-missing' });
  await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const admission of [null, { poolId: pool.poolId, executionSlots: -1 }]) {
    await writeFile(f.configPath, JSON.stringify({ layout: { root: f.data }, admission })); clearConfigCache();
    for (const apply of [false, true]) expect(await f.install(apply)).toMatchObject({ status: 'unavailable' });
  }
  await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('audit failure rolls back the pool and event, including when failure follows audit insertion', async () => {
  const f = await fixture(), original = AuditApplication.prototype.record;
  vi.spyOn(AuditApplication.prototype, 'record').mockImplementation(function (this: AuditApplication, event) { original.call(this, event); throw new Error('AUDIT_UNAVAILABLE'); });
  await expect(f.install(true)).rejects.toThrow('AUDIT_UNAVAILABLE');
  expect(f.rows('SELECT * FROM execution_pools')).toEqual([]); expect(f.rows('SELECT * FROM audit_events')).toEqual([]);
});

it.skipIf(process.platform === 'win32')('rechecks a competing provision under the write transaction and emits no duplicate event', async () => {
  const f = await fixture(), store = await openInstallationPoolStore(f.path, f.config.storage.sqlite);
  const inspect = store.inspect.bind(store);
  store.inspect = async input => { const result = await inspect(input); await f.install(true); return result; };
  const record = vi.fn();
  expect(await installExecutionPool({ scopeId: 'customer', owner: true, pool, apply: true, store, principal: { issuer: 'fixture', subject: 'owner' },
    policyRevision: 'customer-policy', now: () => 1, record })).toMatchObject({ status: 'current' });
  expect(record).not.toHaveBeenCalled(); expect(f.rows('SELECT * FROM audit_events')).toHaveLength(1);
});

it.skipIf(process.platform === 'win32')('an existing Run-store connection rejects RUN_POOL_REQUIRED before apply and creates/reserves the Run after apply', async () => {
  const f = await fixture(), store = await openSqliteAttemptStore(f.path, f.config.storage.sqlite, { now: Date.now, timeoutMs: 60_000 }, 'forbid');
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'task', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }],
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify business result', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
  const actor = { id: 'fixture', issuer: 'fixture', subject: 'owner' }, identity = { scopeId: 'customer', runId: 'run', layoutRevision: 'layout' };
  const create = { commandId: 'create', actor, identity, graph, execution: fixtureExecution(graph), now: 0,
    policy: { schemaVersion: 2 as const, poolId: pool.poolId, capacity: pool.capacity, ordering: ['task'] } };
  try {
    await expect(store.createRun(create)).rejects.toMatchObject({ code: 'RUN_POOL_REQUIRED' }); expect(await store.loadRun('customer', 'run')).toBeNull();
    expect(await f.install(true)).toMatchObject({ status: 'created' });
    expect((await store.createRun(create)).snapshot.identity).toEqual(identity);
    expect((await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 'customer', runId: 'run', expectedRevision: 0, now: 0,
      identities: [{ ...identity, taskId: 'task', attemptId: 'attempt', generation: 1 }] })).snapshot.revision).toBe(1);
  } finally { store.close(); }
});
