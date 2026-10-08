import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ADOPTION_VERIFICATION_LEDGER_VERSION, CURRENT_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteAttemptStore, upgradeExistingProductLedger } from '#adapters/index.js';
import { integrationAdoptionCommandSchema, integrationAdoptionIntentSchema } from '#engine/index.js';
import { DOWNGRADE_TO_V41_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const rows = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
const version = (path: string) => rows(path, 'PRAGMA user_version')[0]?.user_version;
const [base, delivered] = ['a'.repeat(40), 'b'.repeat(40)];
const identity = { runId: 'r', taskId: 't', attemptId: 'a1', scopeId: 's', layoutRevision: 'l1', generation: 1 };
const actor = { id: 'local-os:1000', issuer: 'local-os', subject: '1000' };
/** Exactly what the v41 build wrote: v1 command and intent, keys in the v1 schema order. */
const v1Adopt = (commandId: string, targetRef: string) => JSON.stringify({ schemaVersion: 1, kind: 'adopt',
  command: { schemaVersion: 1, commandId, identity, deliveryCommandId: 'delivery', targetRef }, targetRef, fromCommit: base, toCommit: delivered,
  deliveryRef: `refs/deckent/deliveries/${'c'.repeat(64)}`, basis: 'task-acceptance', acceptance: { runRevision: 3 }, actor });
const v1Rollback = (commandId: string, adoptionCommandId: string, targetRef: string) => JSON.stringify({ schemaVersion: 1, kind: 'rollback',
  command: { schemaVersion: 1, commandId, identity, adoptionCommandId }, targetRef, fromCommit: delivered, toCommit: base, actor });

it('upgrades a v41 ledger to v42: backup at v41, v1 adoptions rewritten losslessly to v2, rollbacks and corrupt rows untouched', async () => {
  expect(CURRENT_LEDGER_VERSION).toBe(49); expect(ADOPTION_VERIFICATION_LEDGER_VERSION).toBe(42);
  const root = await mkdtemp(join(tmpdir(), 'dn-adoption-v42-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path);
  db.exec(DOWNGRADE_TO_V41_LEDGER_SQL);
  const insert = db.prepare('INSERT INTO workspace_adoptions(scope_id,command_id,target_ref,sequence,kind,intent,settled) VALUES(?,?,?,?,?,?,?)');
  insert.run('s', 'settled', 'refs/heads/one', 1, 'adopt', v1Adopt('settled', 'refs/heads/one'), 1);
  insert.run('s', 'interrupted', 'refs/heads/two', 1, 'adopt', v1Adopt('interrupted', 'refs/heads/two'), 0);
  insert.run('s', 'undone', 'refs/heads/three', 1, 'adopt', v1Adopt('undone', 'refs/heads/three'), 1);
  insert.run('s', 'rollback', 'refs/heads/three', 2, 'rollback', v1Rollback('rollback', 'undone', 'refs/heads/three'), 1);
  insert.run('s', 'corrupt', 'refs/heads/four', 1, 'adopt', '{"schemaVersion":1,"kind":"adopt"}', 1);
  // Column/record disagreement (target column differs from the record) is not converted either.
  insert.run('s', 'mismatched', 'refs/heads/five', 1, 'adopt', v1Adopt('mismatched', 'refs/heads/other'), 1);
  db.close();
  const before = rows(path, 'SELECT * FROM workspace_adoptions ORDER BY target_ref,sequence');
  // The v41 journal (this build) refuses an older ledger for normal writers until the service-start upgrade runs.
  expect(() => openSqliteLedger(path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));

  const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date('2026-09-28T12:00:00.000Z'));
  const backupPath = join(backups, 'ledger-v41-2026-09-28T12-00-00-000Z.db');
  expect(upgrade).toEqual({ from: 41, to: CURRENT_LEDGER_VERSION, backupPath });
  expect(version(backupPath)).toBe(41);
  expect(rows(backupPath, 'SELECT * FROM workspace_adoptions ORDER BY target_ref,sequence')).toEqual(before);
  expect(version(path)).toBe(CURRENT_LEDGER_VERSION);

  const after = Object.fromEntries(rows(path, 'SELECT command_id,intent FROM workspace_adoptions').map(row => [String(row.command_id), String(row.intent)]));
  const expected = (commandId: string, targetRef: string) => JSON.stringify(integrationAdoptionIntentSchema.parse({ ...JSON.parse(v1Adopt(commandId, targetRef)),
    schemaVersion: 2, command: { schemaVersion: 2, commandId, identity, deliveryCommandId: 'delivery', targetRef }, verification: null }));
  expect(after.settled).toBe(expected('settled', 'refs/heads/one'));
  expect(after.interrupted).toBe(expected('interrupted', 'refs/heads/two'));
  expect(after.undone).toBe(expected('undone', 'refs/heads/three'));
  expect(after.rollback).toBe(v1Rollback('rollback', 'undone', 'refs/heads/three'));
  expect(after.corrupt).toBe('{"schemaVersion":1,"kind":"adopt"}');
  expect(after.mismatched).toBe(v1Adopt('mismatched', 'refs/heads/other'));

  const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86400000 }, 'forbid');
  try {
    // A pre-upgrade adoption replays with the command today's SDK sends (v2, no verification fields): byte-equal command.
    const settled = (await store.loadAdoption('s', 'settled'))!;
    expect(settled).toMatchObject({ sequence: 1, settled: true, intent: { schemaVersion: 2, verification: null } });
    expect(JSON.stringify(settled.intent.command)).toBe(JSON.stringify(integrationAdoptionCommandSchema.parse(
      { schemaVersion: 2, commandId: 'settled', identity, deliveryCommandId: 'delivery', targetRef: 'refs/heads/one' })));
    // The interrupted adoption settles after the upgrade (the conditional finish matches the rewritten canonical text).
    const interrupted = (await store.loadAdoption('s', 'interrupted'))!;
    expect(interrupted.settled).toBe(false);
    expect(await store.finishAdoption(interrupted.intent)).toMatchObject({ sequence: 1, settled: true });
    // An older adoption can still be rolled back after the upgrade.
    const adopted = (await store.loadAdoption('s', 'settled'))!.intent;
    const rolled = await store.claimAdoption(integrationAdoptionIntentSchema.parse({ schemaVersion: 1, kind: 'rollback',
      command: { schemaVersion: 1, commandId: 'rollback-one', identity, adoptionCommandId: 'settled' }, targetRef: adopted.targetRef,
      fromCommit: adopted.toCommit, toCommit: adopted.fromCommit, actor }));
    expect(rolled).toMatchObject({ sequence: 2, settled: false });
    expect((await store.loadAdoption('s', 'rollback'))!.intent.kind).toBe('rollback');
    await expect(store.loadAdoption('s', 'corrupt')).rejects.toMatchObject({ code: 'ADOPTION_CORRUPT' });
    await expect(store.loadAdoption('s', 'mismatched')).rejects.toMatchObject({ code: 'ADOPTION_CORRUPT' });
  } finally { store.close(); }
});

it.skipIf(process.platform === 'win32')('requires POSIX private file modes: ledger upgrade creates a 0600 backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-backup-private-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V41_LEDGER_SQL); db.close();
  const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date('2026-10-01T00:00:00.000Z'));
  expect((await stat(upgrade!.backupPath)).mode & 0o777).toBe(0o600);
});
