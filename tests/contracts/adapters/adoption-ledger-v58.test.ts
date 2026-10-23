import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ADOPTION_REPOSITORY_LEDGER_VERSION, CURRENT_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteAttemptStore, upgradeExistingProductLedger } from '#adapters/index.js';
import { integrationAdoptionIntentSchema, type IntegrationAdoptionIntent } from '#engine/index.js';
import { DOWNGRADE_TO_V57_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// BENIMSEME-DEPO-KIMLIGI: v58 numbers adoptions per (repository, target). The fixture is the N1 ledger shape of 2026-10-17: 19 settled
// adoptions of one ref made in the old repository and one unsettled queue adoption (sequence 20) that was refused at a fresh clone's fence.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const rows = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
const [base, delivered] = ['a'.repeat(40), 'b'.repeat(40)];
const TARGET = 'refs/heads/dogfood/adopted', OTHER = 'refs/heads/other';
const [A, B, C] = ['a', 'b', 'c'].map(value => value.repeat(64)) as [string, string, string];
const actor = { id: 'local-os:1000', issuer: 'local-os', subject: '1000' };
const identity = (runId: string) => ({ scopeId: 's', runId, taskId: 't', attemptId: 'a1', layoutRevision: 'l1', generation: 1 });
const adopt = (commandId: string, targetRef = TARGET, from = base, to = delivered): IntegrationAdoptionIntent => integrationAdoptionIntentSchema.parse({ schemaVersion: 2, kind: 'adopt',
  command: { schemaVersion: 2, commandId, identity: identity(commandId), deliveryCommandId: `delivery-${commandId}`, targetRef }, targetRef, fromCommit: from, toCommit: to,
  deliveryRef: `refs/deckent/deliveries/${'c'.repeat(64)}`, basis: 'task-acceptance', acceptance: { runRevision: 3 }, verification: null, actor });
const rollback = (commandId: string, adopted: IntegrationAdoptionIntent): IntegrationAdoptionIntent => integrationAdoptionIntentSchema.parse({ schemaVersion: 1, kind: 'rollback',
  command: { schemaVersion: 1, commandId, identity: adopted.command.identity, adoptionCommandId: adopted.command.commandId }, targetRef: adopted.targetRef,
  fromCommit: adopted.toCommit, toCommit: adopted.fromCommit, actor });
const fence = (sequence: number, commandId: string) => ({ sequence, scopeId: 's', commandId });

async function v57Ledger() {
  const root = await mkdtemp(join(tmpdir(), 'dn-adoption-v58-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
  openSqliteLedger(path, options).close();
  const db = new DatabaseSync(path);
  db.exec(DOWNGRADE_TO_V57_LEDGER_SQL);
  const insert = db.prepare('INSERT INTO workspace_adoptions(scope_id,command_id,target_ref,sequence,kind,intent,settled) VALUES(?,?,?,?,?,?,?)');
  for (let sequence = 1; sequence <= 19; sequence++) insert.run('s', `legacy-${sequence}`, TARGET, sequence, 'adopt', JSON.stringify(adopt(`legacy-${sequence}`)), 1);
  insert.run('s', 'queue-adopt-stuck', TARGET, 20, 'adopt', JSON.stringify(adopt('queue-adopt-stuck')), 0);
  const other = adopt('other-1', OTHER);
  insert.run('s', 'other-1', OTHER, 1, 'adopt', JSON.stringify(other), 1);
  insert.run('s', 'other-2', OTHER, 2, 'rollback', JSON.stringify(rollback('other-2', other)), 1);
  db.close();
  return { path, backups };
}

it('upgrades a populated v57 journal to v58: every row kept byte for byte, stamped pre-v58, and the old uniqueness still holds', async () => {
  expect(CURRENT_LEDGER_VERSION).toBe(70); expect(ADOPTION_REPOSITORY_LEDGER_VERSION).toBe(58);
  const { path, backups } = await v57Ledger();
  const before = rows(path, 'SELECT scope_id,command_id,target_ref,sequence,kind,intent,settled FROM workspace_adoptions ORDER BY target_ref,sequence');
  expect(before).toHaveLength(22);
  // The v58 build refuses the older ledger for normal writers until the service-start upgrade runs.
  expect(() => openSqliteLedger(path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date('2026-10-17T12:00:00.000Z'));
  expect(upgrade).toEqual({ from: 57, to: CURRENT_LEDGER_VERSION, backupPath: join(backups, 'ledger-v57-2026-10-17T12-00-00-000Z.db') });
  expect(rows(upgrade!.backupPath, 'SELECT scope_id,command_id,target_ref,sequence,kind,intent,settled FROM workspace_adoptions ORDER BY target_ref,sequence')).toEqual(before);
  expect(rows(path, 'SELECT scope_id,command_id,target_ref,sequence,kind,intent,settled FROM workspace_adoptions ORDER BY target_ref,sequence')).toEqual(before);
  expect(rows(path, 'SELECT DISTINCT repository FROM workspace_adoptions')).toEqual([{ repository: 'pre-v58' }]);
  const db = new DatabaseSync(path);
  try {
    // One sequence per repository and target among applied/unsettled rows; the stamped rows keep their v57 uniqueness.
    expect(() => db.prepare("INSERT INTO workspace_adoptions VALUES('s','dup','pre-v58',?,19,'adopt','{}',1)").run(TARGET)).toThrow(/UNIQUE/u);
    expect(() => db.prepare("INSERT INTO workspace_adoptions VALUES('s','bad','pre-v58',?,21,'adopt','{}',3)").run(TARGET)).toThrow(/CHECK/u);
  } finally { db.close(); }
  // A newer ledger is never reopened by this build (downgrade = restore the pre-switch backup).
  const newer = new DatabaseSync(path); newer.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1}`); newer.close();
  expect(() => openSqliteLedger(path, options, 'allow')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
});

it('after the upgrade a fresh clone starts at 1, the old repository continues its fence chain, and a stuck pre-v58 row is released, never reused', async () => {
  const { path, backups } = await v57Ledger();
  await upgradeExistingProductLedger(path, options, backups, new Date('2026-10-17T12:00:00.000Z'));
  const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86_400_000 }, 'forbid');
  try {
    // The unsettled pre-v58 row has no recorded repository: every repository of that target waits until it is resolved.
    await expect(store.claimAdoption(adopt('fresh'), { repository: B, fence: null })).rejects.toMatchObject({ code: 'ADOPTION_TARGET_BUSY' });
    await expect(store.assertAdoptionFence(TARGET, { repository: A, fence: fence(19, 'legacy-19') })).rejects.toMatchObject({ code: 'ADOPTION_TARGET_BUSY' });
    const stuck = (await store.loadAdoption('s', 'queue-adopt-stuck'))!;
    expect(stuck).toMatchObject({ sequence: 20, settled: false, released: false, repository: null });
    expect(await store.releaseAdoption(stuck.intent)).toMatchObject({ sequence: 20, settled: false, released: true, repository: null });
    expect(await store.releaseAdoption(stuck.intent)).toMatchObject({ released: true });
    // A released record is never settled afterwards; a settled one is never released.
    await expect(store.finishAdoption(stuck.intent)).rejects.toMatchObject({ code: 'ADOPTION_CONFLICT' });
    await expect(store.releaseAdoption((await store.loadAdoption('s', 'legacy-19'))!.intent)).rejects.toMatchObject({ code: 'ADOPTION_CONFLICT' });

    // The fresh clone (no fence) starts its own chain; a fence there that the journal does not name is refused before any row.
    await store.assertAdoptionFence(TARGET, { repository: B, fence: null });
    expect(await store.claimAdoption(adopt('fresh'), { repository: B, fence: null })).toMatchObject({ sequence: 1, settled: false, repository: B });
    // Astra 2616 F2: replaying an existing claim against another repository is refused; the same repository replays it.
    await expect(store.claimAdoption(adopt('fresh'), { repository: C, fence: null })).rejects.toMatchObject({ code: 'ADOPTION_REPOSITORY_CHANGED' });
    expect(await store.claimAdoption(adopt('fresh'), { repository: B, fence: null })).toMatchObject({ sequence: 1, settled: false, repository: B });
    expect(await store.finishAdoption(adopt('fresh'))).toMatchObject({ sequence: 1, settled: true });
    await expect(store.claimAdoption(adopt('fresh-2'), { repository: B, fence: null })).rejects.toMatchObject({ code: 'ADOPTION_FENCE_MISMATCH' });
    await expect(store.assertAdoptionFence(TARGET, { repository: C, fence: fence(5, 'elsewhere') })).rejects.toMatchObject({ code: 'ADOPTION_FENCE_MISMATCH' });
    await expect(store.claimAdoption(adopt('foreign'), { repository: C, fence: fence(5, 'elsewhere') })).rejects.toMatchObject({ code: 'ADOPTION_FENCE_MISMATCH' });
    expect(await store.loadAdoption('s', 'foreign')).toBeNull();

    // The old repository's fence names the stamped chain's latest applied record: it continues at 20 under its own identity, beside the released 20.
    expect(await store.claimAdoption(adopt('old-next'), { repository: A, fence: fence(19, 'legacy-19') })).toMatchObject({ sequence: 20, repository: A });
    expect(await store.finishAdoption(adopt('old-next'))).toMatchObject({ sequence: 20, settled: true });
    // A rollback is checked against the repository's own latest record.
    expect(await store.claimAdoption(rollback('old-undo', adopt('old-next')), { repository: A, fence: fence(20, 'old-next') })).toMatchObject({ sequence: 21 });
    // The stamped chain is immutable: no claim may write under the sentinel, and a corrupt repository value is unreadable.
    await expect(store.claimAdoption(adopt('sentinel'), { repository: 'pre-v58', fence: null })).rejects.toMatchObject({ code: 'ADOPTION_CORRUPT' });
    expect(rows(path, "SELECT count(*) AS n FROM workspace_adoptions WHERE repository='pre-v58'")).toEqual([{ n: 22 }]);
  } finally { store.close(); }
  const db = new DatabaseSync(path); db.prepare("UPDATE workspace_adoptions SET repository='x' WHERE command_id='other-1'").run(); db.close();
  const reopened = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86_400_000 }, 'forbid');
  try { await expect(reopened.loadAdoption('s', 'other-1')).rejects.toMatchObject({ code: 'ADOPTION_CORRUPT' }); } finally { reopened.close(); }
});
