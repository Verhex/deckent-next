import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { bindCapacityResource, CURRENT_LEDGER_VERSION, migrateLedger, openSqliteLedger, revertCapacityResources, upgradeExistingLedger } from '#adapters/core/sqlite-ledger/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { journalMode: 'delete', durability: 'full', busyTimeoutMs: 100 } as const;
function data(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(row => { const name = String(row.name); return [name, db.prepare(`SELECT * FROM "${name}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]; }));
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-resource-migration-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 1000 });
  const actor = { id: 'service', issuer: 'fixture', subject: 'person' }, graph = { schemaVersion: 2 as const, revision: 1,
    tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  try {
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 } });
    await store.createRun({ commandId: 'create', actor, identity: { scopeId: 'project', runId: 'run', layoutRevision: 'layout' }, graph,
      execution: fixtureExecution(graph), now: 1, policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['a'] } });
    await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 'project', runId: 'run', expectedRevision: 0, now: 2,
      identities: [{ scopeId: 'project', runId: 'run', layoutRevision: 'layout', taskId: 'a', attemptId: 'attempt', generation: 1 }] });
  } finally { store.close(); }
  const db = new DatabaseSync(path);
  try { db.exec('BEGIN IMMEDIATE'); revertCapacityResources(db); db.exec('PRAGMA user_version=73; COMMIT'); return { path, backups, previous: data(db) }; } finally { db.close(); }
}
it('migrates a populated v73 Run/Attempt/receipt shape without rewriting rows, fences old writers, and restores the backup exactly', async () => {
  const f = await fixture(); expect(CURRENT_LEDGER_VERSION).toBe(74);
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow('ATTEMPT_STORE_VERSION');
  const upgrade = upgradeExistingLedger(f.path, options, f.backups, new Date('2026-11-03T00:00:00Z'))!;
  expect(upgrade).toMatchObject({ from: 73, to: 74 });
  const current = openSqliteLedger(f.path, options, 'forbid');
  try {
    const after = data(current); delete after.capacity_resources; delete after.run_capacity_resources;
    expect(after).toEqual(f.previous);
    const resource = bindCapacityResource(current, { kind: 'fixture', id: 'connection' }, { executionSlots: 1, inFlightSlots: 1 });
    expect(resource.resourceKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(() => revertCapacityResources(current)).toThrow('CAPACITY_RESOURCE_ROLLBACK_REQUIRES_BACKUP');
  } finally { current.close(); }
  const backupBytes = await readFile(upgrade.backupPath); await copyFile(upgrade.backupPath, f.path); expect(await readFile(f.path)).toEqual(backupBytes);
  const restored = new DatabaseSync(f.path, { readOnly: true });
  try { expect(restored.prepare('PRAGMA user_version').get()?.user_version).toBe(73); expect(data(restored)).toEqual(f.previous); } finally { restored.close(); }
});
it('reverses an unused additive migration with every old row unchanged', async () => {
  const f = await fixture(), db = new DatabaseSync(f.path);
  try {
    db.exec('BEGIN IMMEDIATE'); migrateLedger(db, 'allow'); db.exec('COMMIT');
    db.exec('BEGIN IMMEDIATE'); revertCapacityResources(db); db.exec('PRAGMA user_version=73; COMMIT');
    expect(data(db)).toEqual(f.previous);
  } finally { db.close(); }
});
it('refuses a preexisting conflicting table and rolls the whole migration back', async () => {
  const f = await fixture(), db = new DatabaseSync(f.path);
  try {
    db.exec('CREATE TABLE capacity_resources(wrong TEXT); BEGIN IMMEDIATE');
    expect(() => migrateLedger(db, 'allow')).toThrow('ATTEMPT_STORE_VERSION'); db.exec('ROLLBACK');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(73);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='run_capacity_resources'").get()).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS n FROM attempts').get()?.n).toBe(1);
  } finally { db.close(); }
});
