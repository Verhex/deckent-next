import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { encodeDeckentJson, type DeckentMetrics, type JsonValue } from '#domain/index.js';
import { openSqliteLedger, migrateLedger, CURRENT_LEDGER_VERSION, CATALOG_EVOLUTION_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteCatalogEvolutionStore, upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_V67_LEDGER_SQL, DOWNGRADE_TO_V68_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
import { metric } from '../support/catalog-metrics.js';

// S8-2 (S8-DESIGN §4, §13; lane v69 — v68 is s85's signer step, an empty step on this lane; the lead renumbers at landing): the aggregator pass
// keeps one rebuildable record per scope whose position only moves forward and is never deleted. The pass reads the scope's current metrics
// rows with their record digest and the sealed `now` of the producer command; nothing else in the ledger changes.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const tables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_evolution_positions'").all().map(row => row['name']);
async function ledger(downgrade?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dn-catalog-evolution-v69-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  if (downgrade) { const db = new DatabaseSync(path); db.exec(downgrade); db.close(); }
  return { path, backups };
}
const sealed = (value: DeckentMetrics) => { const bytes = encodeDeckentJson(value as unknown as JsonValue);
  return encodeDeckentJson({ schemaVersion: 1, metric: value as unknown as JsonValue, digest: createHash('sha256').update(bytes).digest('hex') }); };
function insert(db: DatabaseSync, producer: string, value: DeckentMetrics, command: object | null, supersededBy: string | null = null) {
  if (command) db.prepare("INSERT INTO run_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,'{}')").run(value.identity.scopeId, producer, JSON.stringify(command));
  db.prepare('INSERT INTO acceptance_metrics(scope_id,producer_command_id,run_id,task_id,attempt_id,outcome_kind,record,superseded_by) VALUES(?,?,?,?,?,?,?,?)')
    .run(value.identity.scopeId, producer, value.identity.runId, value.identity.taskId, value.identity.attemptId, value.outcome.kind, sealed(value), supersededBy);
}
const pass = (position: number, previousPosition = 0) => ({ schemaVersion: 1 as const, scopeId: 'scope', mode: 'shadow' as const, previousPosition, position, asOfMs: 5,
  registry: { revision: 'seed', digest: 'e'.repeat(64) }, rowsRead: position, truncated: false, keys: [], skippedKeys: 0 });

it('pins the step: v69 is the catalog evolution pass position (v70, the S8-3 suggestions, is the current ledger)', () => {
  expect(CATALOG_EVOLUTION_LEDGER_VERSION).toBe(69); expect(CURRENT_LEDGER_VERSION).toBe(70);
});
it('backs up a v67 ledger and adds only the empty position table; an older build refuses the result', async () => {
  const f = await ledger(DOWNGRADE_TO_V67_LEDGER_SQL);
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-23T00:00:00Z'));
  expect(upgrade).toMatchObject({ from: 67, to: 70 });
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true }), db = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(67); expect(tables(backup)).toEqual([]);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(70); expect(tables(db)).toEqual(['catalog_evolution_positions']);
    expect(db.prepare('SELECT count(*) AS n FROM catalog_evolution_positions').get()?.['n']).toBe(0);
  } finally { backup.close(); db.close(); }
});
it('a position only moves forward with its scope fixed and is never deleted', async () => {
  const f = await ledger(), db = new DatabaseSync(f.path);
  try {
    db.exec("INSERT INTO catalog_evolution_positions(scope_id,position,record) VALUES('s',5,'{}')");
    expect(() => db.exec("INSERT INTO catalog_evolution_positions(scope_id,position,record) VALUES('t',0,'{}')")).toThrow(/CHECK/);
    db.exec('UPDATE catalog_evolution_positions SET position=6');
    for (const sql of ['UPDATE catalog_evolution_positions SET position=6', 'UPDATE catalog_evolution_positions SET position=2', "UPDATE catalog_evolution_positions SET scope_id='x',position=9",
      'DELETE FROM catalog_evolution_positions']) expect(() => db.exec(sql)).toThrow(/CATALOG_EVOLUTION_POSITION_CONFLICT/);
  } finally { db.close(); }
});
it('the v69 → v67 down steps are exact; negative: an existing position table at v68 is refused, never adopted', async () => {
  const f = await ledger(), db = new DatabaseSync(f.path);
  try {
    db.exec(DOWNGRADE_TO_V68_LEDGER_SQL); expect(tables(db)).toEqual([]);
    db.exec('CREATE TABLE catalog_evolution_positions(x)');
    db.exec('BEGIN IMMEDIATE'); expect(() => migrateLedger(db, 'allow')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' })); db.exec('ROLLBACK');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(68);
    db.exec(DOWNGRADE_TO_V67_LEDGER_SQL); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(67); migrateLedger(db, 'allow');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(70); expect(tables(db)).toEqual(['catalog_evolution_positions']);
  } finally { db.close(); }
});
it('reads the scope\'s current rows with their digest and the producer\'s sealed time; superseded rows and other scopes never appear', async () => {
  const f = await ledger(), db = new DatabaseSync(f.path);
  const a = metric({ task: 'a' }), b = metric({ task: 'b', status: 'failed', cause: 'criteria-failed' }), old = metric({ task: 'c', status: 'awaiting-decision' });
  const human = metric({ task: 'c', status: 'accepted', decision: 'human', kinds: ['exit-code', 'human-decision'] }), other = metric({ task: 'x', scope: 'other' });
  try {
    insert(db, 'p1', a, { action: 'apply-task-evaluation', now: 1000 }); insert(db, 'p2', b, null); insert(db, 'p3', old, { action: 'apply-task-evaluation', now: 1500 }, 'p4');
    insert(db, 'p4', human, { operation: 'run-lifecycle', now: 2000 }); insert(db, 'p5', other, { operation: 'run-lifecycle', now: 3000 });
  } finally { db.close(); }
  const store = openSqliteCatalogEvolutionStore(f.path, options, 'read');
  try {
    const newest = await store.recentRows('scope', 10);
    expect(newest.map(row => [row.position, row.atMs, row.metric.identity.taskId])).toEqual([[4, 2000, 'c'], [2, null, 'b'], [1, 1000, 'a']]);
    expect(newest[2]!.digest).toBe(createHash('sha256').update(encodeDeckentJson(a as unknown as JsonValue)).digest('hex'));
    expect((await store.recentRows('scope', 10, 2)).map(row => row.position)).toEqual([2, 1]); expect((await store.recentRows('scope', 1)).map(row => row.position)).toEqual([4]);
    expect((await store.rowsAfter('scope', 1, 10)).map(row => row.position)).toEqual([2, 4]);
    expect(await store.lastPass('scope')).toBeNull();
  } finally { store.close(); }
});
it('records a pass by compare-and-set on the previous position; a concurrent pass is refused; a tampered record is corrupt', async () => {
  const f = await ledger(), store = openSqliteCatalogEvolutionStore(f.path, options, 'write');
  try {
    await store.recordPass(pass(3), 0); expect(await store.lastPass('scope')).toEqual(pass(3));
    await expect(store.recordPass(pass(4), 0)).rejects.toMatchObject({ code: 'CATALOG_EVOLUTION_POSITION_CONFLICT' });
    await expect(store.recordPass(pass(3, 3), 3)).rejects.toMatchObject({ code: 'CATALOG_EVOLUTION_POSITION_CONFLICT' });
    await store.recordPass(pass(7, 3), 3); expect(await store.lastPass('scope')).toMatchObject({ position: 7, previousPosition: 3 });
  } finally { store.close(); }
  const db = new DatabaseSync(f.path);
  try { db.exec("UPDATE catalog_evolution_positions SET position=8,record=replace(record,'\"rowsRead\":7','\"rowsRead\":70')"); } finally { db.close(); }
  const read = openSqliteCatalogEvolutionStore(f.path, options, 'read');
  try { await expect(read.lastPass('scope')).rejects.toMatchObject({ code: 'CATALOG_EVOLUTION_CORRUPT' }); } finally { read.close(); }
});
it('a read of an older ledger is refused, never migrated', async () => {
  const f = await ledger(DOWNGRADE_TO_V67_LEDGER_SQL);
  expect(() => openSqliteCatalogEvolutionStore(f.path, options, 'read')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
});
