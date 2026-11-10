import { copyFile, mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { bindCapacityResource, CURRENT_LEDGER_VERSION, migrateLedger, openSqliteLedger, readCapacityOccupancy, upgradeExistingLedger } from '#adapters/core/sqlite-ledger/index.js';

const roots: string[] = [];
const options = { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' } as const;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function rows(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [String(name), db.prepare(`SELECT * FROM "${String(name)}"`).all()]));
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-index-migration-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(await readFile(new URL('../../fixtures/ledger-v74.sql', import.meta.url), 'utf8'));
  return { path, backups, db };
}
it('freezes the populated v74 storage shapes, nullable allocations, child rows, FTS and integrity before any upgrade', async () => {
  const f = await fixture();
  try {
    expect(f.db.prepare('PRAGMA user_version').get()?.user_version).toBe(74);
    expect(f.db.prepare('PRAGMA table_info(model_invocations)').all().some(row => row.name === 'resource_key')).toBe(false);
    const before = rows(f.db);
    expect(Object.keys(before).filter(name => !name.startsWith('memory_search_'))).toHaveLength(93);
    expect(Object.entries(before).filter(([name, data]) => !name.startsWith('memory_search_') && data.length === 0)).toEqual([]);
    expect(f.db.prepare("SELECT max_calls FROM model_invocation_allocations WHERE allocation_id='allocation_id'").get()?.max_calls).toBeNull();
    expect(f.db.prepare("SELECT max_calls FROM model_invocation_allocations WHERE allocation_id='bounded'").get()?.max_calls).toBe(50);
    expect(f.db.prepare("SELECT text FROM memory_search WHERE memory_search MATCH 'retained'").get()?.text).toBe('migration retained text');
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(f.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    const binding = { kind: 'fixture-legacy-reader', id: 'unbound-login' };
    const resource = bindCapacityResource(f.db, binding, { executionSlots: 1, inFlightSlots: 1 });
    expect(readCapacityOccupancy(f.db, resource.resourceKey, () => binding)).toEqual({ execution: 1, inFlight: 1 });
  } finally { f.db.close(); }
});
it('migrates malformed JSON in every v75 indexed column unchanged and keeps subsequent writes tolerable', async () => {
  const columns = [['runs', 'snapshot'], ['runs', 'policy'], ['dispatches', 'record'], ['effect_intents', 'record'],
    ['run_receipts', 'command'], ['run_receipts', 'snapshot'], ['approvals', 'snapshot'], ['hub_client_receipts', 'record'],
    ['memory_entry_support', 'record'], ['target_queue', 'record']] as const;
  for (const [table, column] of columns) {
    const f = await fixture();
    try {
      // The pre-existing v63 expression index already rejects malformed effect JSON; isolate the new v75 indexes.
      if (table === 'effect_intents') f.db.exec('DROP INDEX effect_intents_producer_attempt');
      const write = (id: string, sequence: number) => {
        if (table === 'hub_client_receipts') f.db.prepare('INSERT INTO hub_client_receipts VALUES(?,?,?)').run('scope_id', id, 'not-json');
        else if (table === 'memory_entry_support') f.db.prepare('INSERT INTO memory_entry_support VALUES(?,?,?,?,?)').run('scope_id', 'entry_id', id, sequence, 'not-json');
        else f.db.exec(`UPDATE ${table} SET ${column}='not-json'`);
      };
      write('corrupt', 2);
      const before = rows(f.db);
      f.db.exec('BEGIN IMMEDIATE');
      migrateLedger(f.db, 'allow'); f.db.exec('COMMIT');
      const after = rows(f.db); delete after.ledger_extensions;
      after.model_invocations = after.model_invocations!.map(({ resource_key, ...row }) => { expect(resource_key).toBeNull(); return row; });
      expect(after, `${table}.${column}`).toEqual(before);
      write('corrupt-v75', 3);
      expect(f.db.prepare(`SELECT ${column} AS value FROM ${table} WHERE NOT json_valid(${column})`).all().length).toBeGreaterThan(0);
      expect(f.db.prepare('PRAGMA user_version').get()?.user_version).toBe(75);
      expect(f.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
      expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { f.db.close(); }
  }
});
it('upgrades every populated v74 table once, uses the lookup indexes, preserves records and restores the private pre-upgrade file', async () => {
  const f = await fixture(), before = rows(f.db); f.db.close();
  expect(CURRENT_LEDGER_VERSION).toBe(75);
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow('ATTEMPT_STORE_VERSION');
  const upgrade = upgradeExistingLedger(f.path, options, f.backups, new Date('2026-11-09T00:00:00Z'))!;
  expect(upgrade).toMatchObject({ from: 74, to: 75 });
  if (process.platform !== 'win32') expect((await stat(upgrade.backupPath)).mode & 0o777).toBe(0o600);
  let db = openSqliteLedger(f.path, options, 'forbid');
  try {
    const after = rows(db); expect(after.ledger_extensions).toEqual([]); delete after.ledger_extensions;
    expect(after.model_invocations?.map(({ resource_key, ...row }) => { expect(resource_key).toBeNull(); return row; })).toEqual(before.model_invocations);
    after.model_invocations = before.model_invocations!; expect(after).toEqual(before);
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const plans: [string, string][] = [
      ['model_invocations_resource_claimed', "SELECT record FROM model_invocations WHERE state='claimed' AND resource_key='resource_key' UNION ALL SELECT record FROM model_invocations WHERE state='claimed' AND resource_key IS NULL"],
      ['run_capacity_resources_key', "SELECT task_id FROM run_capacity_resources WHERE resource_key='resource_key'"],
      ['runs_nonterminal', "SELECT scope_id,run_id FROM runs WHERE (CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.state.kind') END)!='terminal'"],
      ['runs_pool', "SELECT snapshot FROM runs WHERE (CASE WHEN json_valid(policy) THEN json_extract(policy,'$.poolId') END)='pool_id' OR (CASE WHEN json_valid(policy) THEN json_extract(policy,'$.poolId') END) IS NULL"],
      ['effect_intents_compensates', "SELECT command_id FROM effect_intents WHERE scope_id='scope_id' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.intent.command.compensates') END)='original' AND state!='refused' ORDER BY CASE state WHEN 'settled' THEN 0 ELSE 1 END,sequence DESC LIMIT 1"],
      ['run_receipts_evaluation', "SELECT command FROM run_receipts WHERE scope_id='scope_id' AND (CASE WHEN json_valid(command) THEN json_extract(command,'$.action') END)='apply-task-evaluation' AND (CASE WHEN json_valid(command) THEN json_extract(command,'$.evaluation.identity.runId') END)='run_id' AND (CASE WHEN json_valid(command) THEN json_extract(command,'$.evaluation.identity.attemptId') END)='attempt_id' ORDER BY (CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.revision') END) DESC LIMIT 1"],
      ['approvals_pending', "SELECT approval_id FROM approvals WHERE current=1 AND subject_kind='task' AND (CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.status') END)='pending' ORDER BY scope_id,approval_id LIMIT 10"],
      ['hub_client_receipts_revocations', "SELECT record FROM hub_client_receipts WHERE scope_id='scope_id' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.value.result.kind') END)='revocations' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.value.result.hubId') END)='hub_id' ORDER BY rowid DESC LIMIT 1"],
      ['hub_client_receipts_revocation_cursor', "SELECT rowid,record FROM hub_client_receipts WHERE scope_id='scope_id' AND rowid>0 AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.value.result.kind') END)='revocations' ORDER BY rowid LIMIT 10"],
      ['memory_entry_support_run', "SELECT entry_id,support_id FROM memory_entry_support WHERE scope_id='scope_id' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.value.source.runId') END)='run_id' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.value.source.attemptId') END)='attempt_id' ORDER BY rowid"],
      ['target_queue_run', "SELECT * FROM target_queue WHERE scope_id='scope_id' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.request.identity.runId') END)='run_id' ORDER BY command_id LIMIT 10"],
      ['target_queue_run_effect', "SELECT * FROM target_queue WHERE scope_id='scope_id' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.effectCommandIds[3]') END)='run_id' LIMIT 2"],
      ['target_queue_epoch', "SELECT max((CASE WHEN json_valid(record) THEN json_extract(record,'$.epoch') END)) FROM target_queue WHERE target_key='target_key'"],
      ['target_queue_retry_candidates', "SELECT * FROM target_queue WHERE state='settled' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.outcome') END)='conflict-needs-reattempt' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.reason') END)='PATCH_BASE_ADVANCED' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.request.deliveryIntent') END) IS NOT NULL AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.request.submittedAt') END)>0 ORDER BY target_key,ordinal LIMIT 10"],
      ['target_queue_reattempt', "SELECT 1 FROM target_queue WHERE scope_id='scope_id' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.request.reattempt.sourceCommandId') END)='source'"],
      ['dispatches_run', "SELECT 1 FROM dispatches WHERE scope_id='scope_id' AND json_valid(record) AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.request.identity.runId') END)='run_id' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.terminal') END) IS NULL"],
      ['run_quota_waits_channel', "SELECT * FROM run_quota_waits WHERE channel_id='channel_id' AND deadline_ms>0 AND released_at_ms IS NULL AND channel_held=1 ORDER BY deadline_ms DESC LIMIT 1"],
    ];
    for (const [index, sql] of plans) expect(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().flatMap(row => String(row.detail).split(/\W+/u)), sql).toContain(index);
    expect(db.prepare("SELECT command_id FROM effect_intents WHERE (CASE WHEN json_valid(record) THEN json_extract(record,'$.intent.command.compensates') END)='original'").all()).toHaveLength(4);
    expect(db.prepare("SELECT command_id FROM effect_intents WHERE scope_id='scope_id' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.intent.command.compensates') END)='original' AND state!='refused' ORDER BY CASE state WHEN 'settled' THEN 0 ELSE 1 END,sequence DESC LIMIT 1").get()?.command_id).toBe('settled');
    expect(db.prepare("SELECT attempt_id FROM run_quota_waits WHERE channel_id='channel_id' AND deadline_ms>0 AND released_at_ms IS NULL AND channel_held=1").all()).toEqual([{ attempt_id: 'attempt_id' }]);
    expect(db.prepare("SELECT approval_id FROM approvals WHERE current=1 AND subject_kind='task' AND (CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.status') END)='pending'").all()).toEqual([{ approval_id: 'approval_id' }]);
    expect(db.prepare("SELECT command_id FROM target_queue WHERE scope_id='scope_id' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.request.identity.runId') END)='run_id'").all()).toEqual([{ command_id: 'command_id' }]);
    expect(db.prepare("SELECT max((CASE WHEN json_valid(record) THEN json_extract(record,'$.epoch') END)) AS epoch FROM target_queue WHERE target_key='target_key'").get()?.epoch).toBe(2);
    expect(db.prepare("SELECT attempt_id FROM dispatches WHERE scope_id='scope_id' AND json_valid(record) AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.request.identity.runId') END)='run_id' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.terminal') END) IS NULL").all()).toEqual([{ attempt_id: 'attempt_id' }]);
    db.prepare('INSERT INTO ledger_extensions VALUES(?,?)').run('fixture.extension', 1);
    expect(() => db.prepare('INSERT INTO ledger_extensions VALUES(?,?)').run('fixture.extension', 2)).toThrow(/UNIQUE/);
    expect(() => db.prepare('INSERT INTO ledger_extensions VALUES(?,?)').run('', 1)).toThrow(/CHECK/);
    expect(() => db.prepare('INSERT INTO ledger_extensions VALUES(?,?)').run('invalid', 0)).toThrow(/CHECK/);
  } finally { db.close(); }
  expect(upgradeExistingLedger(f.path, options, f.backups, new Date())).toBeNull();
  db = openSqliteLedger(f.path, options, 'forbid');
  try { expect(db.prepare('SELECT * FROM ledger_extensions').all()).toEqual([{ namespace: 'fixture.extension', version: 1 }]); }
  finally { db.close(); }
  const backup = new DatabaseSync(upgrade.backupPath, { readOnly: true });
  try { expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(74); expect(rows(backup)).toEqual(before); }
  finally { backup.close(); }
  await copyFile(upgrade.backupPath, f.path);
  expect(await readFile(f.path)).toEqual(await readFile(upgrade.backupPath));
  const restored = new DatabaseSync(f.path, { readOnly: true });
  try { expect(restored.prepare('PRAGMA user_version').get()?.user_version).toBe(74); expect(rows(restored)).toEqual(before); expect(restored.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok'); }
  finally { restored.close(); }
  // A contradictory schema must roll back the column and every index, leaving the v74 data intact.
  const bad = new DatabaseSync(f.path); bad.exec('CREATE TABLE ledger_extensions(wrong TEXT)'); bad.close();
  expect(() => openSqliteLedger(f.path, options)).toThrow('ATTEMPT_STORE_VERSION');
  const refused = new DatabaseSync(f.path);
  try {
    const unchanged = rows(refused); delete unchanged.ledger_extensions; expect(unchanged).toEqual(before);
    expect(refused.prepare('PRAGMA user_version').get()?.user_version).toBe(74);
    expect(refused.prepare('PRAGMA table_info(model_invocations)').all().some(row => row.name === 'resource_key')).toBe(false);
    expect(refused.prepare("SELECT name FROM sqlite_schema WHERE name='effect_intents_compensates'").get()).toBeUndefined();
  } finally { refused.close(); }
});
