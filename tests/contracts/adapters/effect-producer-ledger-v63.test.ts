import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger, migrateLedger, CURRENT_LEDGER_VERSION, EFFECT_PRODUCER_LEDGER_VERSION, migrateEffectProducerIndex, revertEffectProducerIndex } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteAttemptStore, upgradeExistingProductLedger } from '#adapters/index.js';
import { effectRecordSchema } from '#domain/index.js';
import { DOWNGRADE_TO_V62_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// S6R-1: ledger v63 adds only the producer-Attempt index over effect intents. Older intents (no producer) are not read or rewritten and index
// as NULL — the recovery gate's fail-closed window rule input, never a match; the step keeps an older build (which refuses v63) away.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const attempt = { scopeId: 's', runId: 'run', taskId: 'task', attemptId: 'attempt-1', layoutRevision: 'layout', generation: 1 };
const descriptor = { schemaVersion: 1, operation: { id: 'record.write', version: 1 }, targetKind: 'record', effectClass: 'write', approval: 'policy',
  precondition: 'none', compensation: null, inputMaxBytes: 4096 } as const;
const intent = (commandId: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, command: { schemaVersion: 1, commandId, scopeId: 's',
  operation: descriptor.operation, target: { kind: 'record', id: `item-${commandId}` }, idempotencyKey: `key-${commandId}`, input: null, expectedVersion: null },
  descriptor, actor: { id: 'author', issuer: 'test', subject: 'fixture' }, idempotencyKeyHash: digest(`s\0key-${commandId}`), inputDigest: digest('input'), ...extra });
const byAttempt = "SELECT command_id FROM effect_intents WHERE scope_id=? AND json_extract(record,'$.intent.producer.identity.attemptId')=?";
const indexed = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='effect_intents_producer_attempt'").all().length === 1;
/** A v62 ledger holding one older intent (no producer), written as v62 wrote it. */
async function v62() {
  const root = await mkdtemp(join(tmpdir(), 'dn-effect-producer-v63-')); roots.push(root);
  const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups);
  openSqliteLedger(path, options).close();
  const legacy = JSON.stringify(effectRecordSchema.parse({ intent: intent('old'), sequence: 1, state: 'unknown', evidence: null, refusal: null }));
  const db = new DatabaseSync(path);
  db.exec(DOWNGRADE_TO_V62_LEDGER_SQL);
  db.prepare('INSERT INTO effect_intents(scope_id,command_id,target_kind,target_id,sequence,idempotency_key_hash,state,record) VALUES(?,?,?,?,?,?,?,?)')
    .run('s', 'old', 'record', 'item-old', 1, digest('s\0key-old'), 'unknown', legacy);
  db.close();
  return { path, backups, legacy };
}

it('pins the step: v63 is the effect-producer index (S7 v64 is current)', () => {
  expect(EFFECT_PRODUCER_LEDGER_VERSION).toBe(63); expect(CURRENT_LEDGER_VERSION).toBe(67);
});
it('backs up v62 and adds only the index; the older intent stays byte for byte and reads without producer', async () => {
  const f = await v62();
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const upgrade = await upgradeExistingProductLedger(f.path, options, f.backups, new Date('2026-10-23T00:00:00Z'));
  expect(upgrade).toMatchObject({ from: 62, to: 67 });
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true });
  try { expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(62); expect(indexed(backup)).toBe(false); } finally { backup.close(); }
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(67); expect(indexed(db)).toBe(true);
    expect(db.prepare('SELECT record FROM effect_intents').get()?.record).toBe(f.legacy);
  } finally { db.close(); }
  const store = await openSqliteAttemptStore(f.path, options, { now: () => 1, timeoutMs: 1000 }, 'forbid');
  try {
    expect((await store.loadEffect('s', 'old'))!.intent).not.toHaveProperty('producer');
    await store.claimEffect(intent('a1', { producer: { kind: 'attempt', identity: attempt } }) as never);
    await store.claimEffect(intent('p1', { producer: { kind: 'principal' } }) as never);
  } finally { store.close(); }
  const after = new DatabaseSync(f.path, { readOnly: true });
  try {
    // A lookup by Attempt meets only its own intents through the index; the older row is the NULL-producer set.
    expect(after.prepare(byAttempt).all('s', 'attempt-1')).toEqual([{ command_id: 'a1' }]);
    expect(JSON.stringify(after.prepare('EXPLAIN QUERY PLAN ' + byAttempt).all('s', 'attempt-1'))).toContain('effect_intents_producer_attempt');
    expect(after.prepare("SELECT command_id FROM effect_intents WHERE scope_id=? AND json_extract(record,'$.intent.producer') IS NULL").all('s')).toEqual([{ command_id: 'old' }]);
  } finally { after.close(); }
});
it('the v63 → v62 fixture and the down step are exact for a ledger without producer records, and the upgrade replays to the same state', async () => {
  const f = await v62(); const db = new DatabaseSync(f.path);
  try {
    migrateLedger(db, 'allow'); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(67); expect(indexed(db)).toBe(true);
    db.exec(DOWNGRADE_TO_V62_LEDGER_SQL); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(62); expect(indexed(db)).toBe(false);
    migrateLedger(db, 'allow'); expect(indexed(db)).toBe(true);
    db.exec('BEGIN IMMEDIATE'); revertEffectProducerIndex(db); db.exec('COMMIT'); expect(indexed(db)).toBe(false);
    db.exec('BEGIN IMMEDIATE'); migrateEffectProducerIndex(db); db.exec('COMMIT'); expect(indexed(db)).toBe(true);
    expect(db.prepare('SELECT record FROM effect_intents').get()?.record).toBe(f.legacy);
  } finally { db.close(); }
});
it('negative: the step never adopts an existing index, and a build refuses a ledger newer than its own (how alpha.53/54 meet v63)', async () => {
  const f = await v62(); const db = new DatabaseSync(f.path);
  try {
    db.exec("CREATE INDEX effect_intents_producer_attempt ON effect_intents(scope_id)");
    expect(() => migrateLedger(db, 'allow')).toThrow(); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(62);
    db.exec(`DROP INDEX effect_intents_producer_attempt; PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`);
  } finally { db.close(); }
  expect(() => openSqliteLedger(f.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  expect(() => openSqliteLedger(f.path, options)).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
});
