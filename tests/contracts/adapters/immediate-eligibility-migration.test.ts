import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { downgradeRunEligibilityFixtures } from '../support/legacy-run-eligibility.js';

const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const };
const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
async function seed(path: string, version = 11) {
  const store = await openSqliteAttemptStore(path, options);
  await admitRunAttempts(store, [{ scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }]);
  await store.cancelRun({ commandId: 'cancel', actor, scopeId: 's', runId: 'r', expectedRevision: 1 });
  await store.cancelRun({ commandId: 'cancel-again', actor, scopeId: 's', runId: 'r', expectedRevision: 2 });
  const expected = await store.loadRun('s', 'r'); store.close();
  const db = new DatabaseSync(path);
  downgradeRunEligibilityFixtures(db);
  if (version < 14) db.exec('DROP INDEX model_invocations_allocation_state; DROP TABLE model_invocation_contents; DROP TABLE model_invocations; DROP TABLE model_invocation_allocations');
  if (version < 13) db.exec('DROP TABLE model_activation_receipts; DROP TABLE model_activations');
  if (version < 11) db.exec('DROP TABLE installation_ownership');
  if (version < 10) db.exec('DROP TABLE service_shutdown_commands; DROP TABLE service_shutdown_outcomes');
  if (version < 9) db.exec('DROP TABLE run_workspace_custody');
  if (version < 7) db.exec('DROP TABLE cancellation_deliveries');
  if (version < 4) db.exec('DROP TABLE execution_pools');
  db.exec(`PRAGMA user_version=${version}`); db.close(); return expected;
}
function dump(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    return { version: db.prepare('PRAGMA user_version').get(), schema,
      tables: Object.fromEntries(schema.filter(row => row.type === 'table').map(row => {
        const name = String(row.name).replaceAll('"', '""');
        return [row.name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()];
      })) };
  } finally { db.close(); }
}
async function workspace(work: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-immediate-migration-'));
  try { await work(join(root, 'ledger.db')); } finally { await rm(root, { recursive: true, force: true }); }
}
it('creates an empty current ledger directly from version zero', async () => workspace(async path => {
  const store = await openSqliteAttemptStore(path, options); store.close();
  expect(dump(path).version).toMatchObject({ user_version: CURRENT_LEDGER_VERSION });
}));
it.each([3, 4, 5, 6, 7, 8, 9, 10, 11])('converts evidenced history from version %i and preserves commands, attempts and revisions', async version => workspace(async path => {
  const expected = await seed(path, version), before = dump(path);
  const store = await openSqliteAttemptStore(path, options);
  try {
    expect(await store.loadRun('s', 'r')).toEqual(expected);
    const replay = await store.cancelRun({ commandId: 'cancel-again', actor, scopeId: 's', runId: 'r', expectedRevision: 2 });
    expect(replay.snapshot).toEqual(expected);
  } finally { store.close(); }
  const after = dump(path); expect(after.version).toMatchObject({ user_version: CURRENT_LEDGER_VERSION });
  expect(after.tables.attempts).toEqual(before.tables.attempts);
  expect(after.tables.attempt_receipts).toEqual(before.tables.attempt_receipts);
  expect(after.tables.dispatches).toEqual(before.tables.dispatches);
  expect(after.tables.run_receipts!.map(row => row.command)).toEqual(before.tables.run_receipts!.map(row => row.command));
  for (const row of after.tables.run_receipts!) {
    const snapshot = JSON.parse(String(row.snapshot));
    expect(snapshot.schemaVersion).toBe(3);
    expect(snapshot.progress).toEqual(expect.arrayContaining([expect.objectContaining({ eligibility: { kind: 'immediate' } })]));
    expect(snapshot.progress[0]).not.toHaveProperty('eligibleAt');
  }
}));
const mutations: ReadonlyArray<readonly [string, (db: DatabaseSync) => void]> = [
  ['missing creation receipt', db => { db.exec("DELETE FROM run_receipts WHERE command_id='create-run:r'"); }],
  ['duplicate creation receipt', db => { db.exec("INSERT INTO run_receipts SELECT scope_id,'other',json_set(command,'$.commandId','other'),snapshot FROM run_receipts WHERE command_id='create-run:r'"); }],
  ['wrong initial eligibility', db => { db.exec("UPDATE run_receipts SET snapshot=json_set(snapshot,'$.progress[0].eligibleAt',1) WHERE command_id='create-run:r'"); }],
  ['wrong current eligibility', db => { db.exec("UPDATE runs SET snapshot=json_set(snapshot,'$.progress[0].eligibleAt',1)"); }],
  ['wrong historical eligibility', db => { db.exec("UPDATE run_receipts SET snapshot=json_set(snapshot,'$.progress[0].eligibleAt',1) WHERE command_id='reserve:r'"); }],
  ['dual shape', db => { db.exec("UPDATE runs SET snapshot=json_set(snapshot,'$.progress[0].eligibility',json('{\"kind\":\"immediate\"}'))"); }],
  ['orphan receipt', db => { db.exec("UPDATE run_receipts SET snapshot=json_set(snapshot,'$.identity.runId','orphan') WHERE command_id='cancel'"); }],
  ['wrong command scope', db => { db.exec("UPDATE run_receipts SET command=json_set(command,'$.scopeId','other') WHERE command_id='reserve:r'"); }],
  ['wrong command run', db => { db.exec("UPDATE run_receipts SET command=json_set(command,'$.runId','other') WHERE command_id='cancel'"); }],
  ['wrong command ID', db => { db.exec("UPDATE run_receipts SET command=json_set(command,'$.commandId','other') WHERE command_id='cancel'"); }],
  ['unknown command action', db => { db.exec("UPDATE run_receipts SET command=json_set(command,'$.action','unrecognized') WHERE command_id='cancel'"); }],
  ['wrong expected revision', db => { db.exec("UPDATE run_receipts SET command=json_set(command,'$.expectedRevision',99) WHERE command_id='reserve:r'"); }],
  ['wrong attempted identity', db => { db.exec("UPDATE run_receipts SET command=json_set(command,'$.identities[0].attemptId','other') WHERE command_id='reserve:r'"); }],
  ['nonzero initial snapshot', db => { db.exec("UPDATE run_receipts SET snapshot=json_set(snapshot,'$.revision',1) WHERE command_id='create-run:r'"); }],
  ['different policy', db => { db.exec("UPDATE runs SET policy=json_set(policy,'$.capacity.executionSlots',20)"); }],
  ['wrong row revision', db => { db.exec('UPDATE runs SET revision=99'); }],
  ['future historical snapshot', db => { db.exec("UPDATE run_receipts SET snapshot=json_set(snapshot,'$.revision',99) WHERE command_id='cancel'"); }],
  ['malformed command JSON', db => { db.exec("UPDATE run_receipts SET command='{' WHERE command_id='cancel'"); }],
];
it.each(mutations)('rejects %s with typed error and every table unchanged', async (_name, mutate) => workspace(async path => {
  await seed(path); const db = new DatabaseSync(path); mutate(db); db.close(); const before = dump(path);
  await expect(openSqliteAttemptStore(path, options)).rejects.toMatchObject({ code: 'LEDGER_MIGRATION_EVIDENCE_REQUIRED' });
  expect(dump(path)).toEqual(before);
}));
it('does not relabel a SQLite update failure as missing evidence and rolls all previous writes back', async () => workspace(async path => {
  await seed(path); const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER refuse_conversion BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'fixture-update-failure'); END"); db.close();
  const before = dump(path);
  await expect(openSqliteAttemptStore(path, options)).rejects.toThrow('fixture-update-failure');
  expect(dump(path)).toEqual(before);
}));
