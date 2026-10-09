import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger, CURRENT_LEDGER_VERSION, DECISION_PORT_LEDGER_VERSION, RUN_PARKING_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { DOWNGRADE_TO_V45_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { createRun } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-run-parking-v45-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path);
  const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 'task', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  const run = createRun({ scopeId: 's', runId: 'r', layoutRevision: 'layout' }, graph, 0, fixtureExecution(graph));
  const legacy = { ...run, schemaVersion: 3 } as Record<string, unknown>; delete legacy.state;
  const snapshot = JSON.stringify(legacy);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('s', 'r', run.revision, snapshot, '{}');
  db.prepare('INSERT INTO run_receipts VALUES(?,?,?,?)').run('s', 'create', '{"create":true}', snapshot);
  // A real v44 shape: no v46 decision tables (batch 27 renumbered AOF-DECISION-PORT to v46), Run snapshots v3.
  db.exec(`${DOWNGRADE_TO_V45_LEDGER_SQL} PRAGMA user_version=44;`); db.close();
  return { root, path, backups, snapshot, run };
}

const decisionTables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'decision_%' ORDER BY name").all().map(row => row.name);
it('backs up v44 before explicitly migrating all Run snapshots and historical receipts to v4, then adds v46 decision custody', async () => {
  const f = await fixture(); expect(RUN_PARKING_LEDGER_VERSION).toBe(45); expect(DECISION_PORT_LEDGER_VERSION).toBe(46); expect(CURRENT_LEDGER_VERSION).toBe(49);
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-02T00:00:00Z'));
  expect(upgrade?.from).toBe(44); expect(upgrade?.to).toBe(CURRENT_LEDGER_VERSION);
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true });
  expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(44);
  expect(backup.prepare('SELECT snapshot FROM runs').get()?.snapshot).toBe(f.snapshot); expect(decisionTables(backup)).toEqual([]); backup.close();
  const db = new DatabaseSync(f.path);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
  expect(decisionTables(db)).toEqual(['decision_cases', 'decision_command_receipts']);
  const migrated = JSON.parse(String(db.prepare('SELECT snapshot FROM runs').get()?.snapshot));
  expect(migrated).toEqual({ ...JSON.parse(f.snapshot), schemaVersion: 4, state: { kind: 'running' } });
  expect(JSON.parse(String(db.prepare('SELECT snapshot FROM run_receipts').get()?.snapshot))).toEqual(migrated);
  expect(db.prepare('SELECT command FROM run_receipts').get()?.command).toBe('{"create":true}');
  db.close();
});

it('rolls the entire migration back on malformed Run data and preserves its v44 backup', async () => {
  const f = await fixture(); const before = new DatabaseSync(f.path);
  before.prepare('UPDATE run_receipts SET snapshot=?').run('{"schemaVersion":3}'); before.close();
  await expect(upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-02T00:00:00Z')))
    .rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  const db = new DatabaseSync(f.path);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(44);
  expect(db.prepare('SELECT snapshot FROM runs').get()?.snapshot).toBe(f.snapshot); expect(decisionTables(db)).toEqual([]); db.close();
  const backup = new DatabaseSync(join(f.backups, 'ledger-v44-2026-10-02T00-00-00-000Z.db'), { readOnly: true });
  expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(44); backup.close();
});
