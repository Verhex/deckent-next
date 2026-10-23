import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { LocalOsSessionAuthority, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { migrateEffectProducerIndex, revertEffectProducerIndex } from '#adapters/core/sqlite-ledger/index.js';
import { effectIntentSchema, operationDescriptorSchema, settleEffect, type EffectCommand, type EffectIntent, type OperationDescriptor } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization, refuseRequiredApproval } from '#engine/index.js';

// S6R-1 (design §7 step 4, §12): every new effect intent names its producer — the Attempt that ran it or `principal` (a direct command
// with no Attempt). Older intents have none and stay readable; they are the fail-closed window rule's input in S6R-4, never a match.
const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const attempt = { scopeId: 's', runId: 'run', taskId: 'task', attemptId: 'attempt-1', layoutRevision: 'layout', generation: 1 };
const descriptor: OperationDescriptor = { schemaVersion: 1, operation: { id: 'record.write', version: 1 }, targetKind: 'record', effectClass: 'write', approval: 'policy',
  precondition: 'none', compensation: null, inputMaxBytes: 4096 };
const command = (commandId = 'op-1'): EffectCommand => ({ schemaVersion: 1, commandId, scopeId: 's', operation: descriptor.operation,
  target: { kind: 'record', id: `item-${commandId}` }, idempotencyKey: `key-${commandId}`, input: { value: 1 }, expectedVersion: null });
const actor = { id: 'author', issuer: 'test', subject: 'fixture' };
const intent = (commandId = 'op-1', extra: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, command: command(commandId), descriptor, actor,
  idempotencyKeyHash: digest(`s\0key-${commandId}`), inputDigest: digest('input'), ...extra }) as EffectIntent;
async function ledger() {
  const root = await mkdtemp(join(tmpdir(), 'effect-producer-')); roots.push(root);
  const path = join(root, 'ledger.db'), store = await openSqliteAttemptStore(path, options, { now: () => 1, timeoutMs: 1000 }, 'allow');
  stores.push(store); return { store, path };
}

it('refuses a new intent that names no producer, before anything is written', async () => {
  const { store, path } = await ledger();
  await expect(store.claimEffect(intent())).rejects.toMatchObject({ name: 'EffectError', code: 'EFFECT_INVALID' });
  const db = new DatabaseSync(path); try { expect(db.prepare('SELECT COUNT(*) AS n FROM effect_intents').get()).toEqual({ n: 0 }); } finally { db.close(); }
});

it.each([['an Attempt', { kind: 'attempt', identity: attempt }], ['a direct principal command', { kind: 'principal' }]] as const)('records %s as producer and replays the stored intent byte for byte', async (_label, producer) => {
  const { store } = await ledger();
  const claimed = await store.claimEffect(intent('op-1', { producer }));
  expect(claimed.intent.producer).toEqual(producer);
  expect(await store.loadEffect('s', 'op-1')).toEqual(claimed);
  // The CAS compares stored bytes: a settle keeps the producer exactly as claimed.
  const settled = await store.saveEffect(claimed, settleEffect(claimed, { kind: 'idempotency-record', version: '2', observedAt: 3 }));
  expect((await store.loadEffect('s', 'op-1'))!.intent.producer).toEqual(producer);
  expect(settled.state).toBe('settled');
});

it('refuses a producer that is neither a full Attempt identity nor principal', () => {
  for (const producer of [{ kind: 'attempt' }, { kind: 'attempt', identity: { ...attempt, generation: 0 } }, { kind: 'worker' }, { kind: 'principal', identity: attempt }, null]) {
    expect(effectIntentSchema.safeParse(intent('op-1', { producer })).success).toBe(false);
  }
});

it('reads an older intent without producer (legacy row) and settles it without adding one', async () => {
  const { store, path } = await ledger();
  const legacy = { intent: intent('old'), sequence: 1, state: 'claimed', evidence: null, refusal: null };
  const db = new DatabaseSync(path);
  try {
    db.prepare('INSERT INTO effect_intents(scope_id,command_id,target_kind,target_id,sequence,idempotency_key_hash,state,record) VALUES(?,?,?,?,?,?,?,?)')
      .run('s', 'old', 'record', 'item-old', 1, legacy.intent.idempotencyKeyHash, 'claimed', JSON.stringify(legacy));
  } finally { db.close(); }
  const read = (await store.loadEffect('s', 'old'))!;
  expect(read.intent).not.toHaveProperty('producer');
  const settled = await store.saveEffect(read, settleEffect(read, { kind: 'idempotency-record', version: '1', observedAt: 2 }));
  expect(settled.intent).not.toHaveProperty('producer');
});

it('carries an optional task-scoped idempotency declaration on the descriptor without a default (stored descriptors re-parse byte for byte)', async () => {
  const declared = { ...descriptor, idempotencyScope: 'task' as const };
  expect(JSON.stringify(operationDescriptorSchema.parse(declared))).toBe(JSON.stringify(declared));
  expect(operationDescriptorSchema.parse(descriptor)).not.toHaveProperty('idempotencyScope');
  expect(operationDescriptorSchema.parse({ ...descriptor, idempotencyScope: 'command' }).idempotencyScope).toBe('command');
  for (const value of ['attempt', 'run', null, '']) expect(operationDescriptorSchema.safeParse({ ...descriptor, idempotencyScope: value }).success).toBe(false);
  const { store } = await ledger();
  const claimed = await store.claimEffect(intent('op-1', { descriptor: declared, producer: { kind: 'principal' } }));
  expect(JSON.stringify((await store.loadEffect('s', 'op-1'))!.intent.descriptor)).toBe(JSON.stringify(declared));
  expect(claimed.intent.descriptor.idempotencyScope).toBe('task');
});

it('indexes the producer Attempt (migration step, number assigned at landing): a lookup by Attempt meets only its own intents, legacy rows stay null', async () => {
  const { store, path } = await ledger();
  await store.claimEffect(intent('a1', { producer: { kind: 'attempt', identity: attempt } }));
  await store.claimEffect(intent('a2', { producer: { kind: 'attempt', identity: { ...attempt, attemptId: 'attempt-2' } } }));
  await store.claimEffect(intent('p1', { producer: { kind: 'principal' } }));
  const db = new DatabaseSync(path);
  try {
    const legacy = { intent: intent('old'), sequence: 1, state: 'unknown', evidence: null, refusal: null };
    db.prepare('INSERT INTO effect_intents(scope_id,command_id,target_kind,target_id,sequence,idempotency_key_hash,state,record) VALUES(?,?,?,?,?,?,?,?)')
      .run('s', 'old', 'record', 'item-old', 1, legacy.intent.idempotencyKeyHash, 'unknown', JSON.stringify(legacy));
    db.exec('BEGIN IMMEDIATE'); migrateEffectProducerIndex(db); db.exec('COMMIT');
    const byAttempt = "SELECT command_id FROM effect_intents WHERE scope_id=? AND json_extract(record,'$.intent.producer.identity.attemptId')=?";
    expect(db.prepare(byAttempt).all('s', 'attempt-1')).toEqual([{ command_id: 'a1' }]);
    expect(JSON.stringify(db.prepare('EXPLAIN QUERY PLAN ' + byAttempt).all('s', 'attempt-1'))).toContain('effect_intents_producer_attempt');
    expect(db.prepare("SELECT command_id FROM effect_intents WHERE scope_id=? AND json_extract(record,'$.intent.producer') IS NULL").all('s')).toEqual([{ command_id: 'old' }]);
    // Re-running the step is refused (index exists): a migration runs once per ledger version, never silently adopts.
    expect(() => migrateEffectProducerIndex(db)).toThrow();
    db.exec('BEGIN IMMEDIATE'); revertEffectProducerIndex(db); db.exec('COMMIT');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='effect_intents_producer_attempt'").all()).toEqual([]);
    expect(db.prepare(byAttempt).all('s', 'attempt-1')).toEqual([{ command_id: 'a1' }]);
  } finally { db.close(); }
});

/** The application states its producer at construction (composition-trusted, never from the wire); a recorded intent is resumed only by
 * the same producer, while an older intent without one stays resumable. */
it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] stamps the composition producer and refuses a resume by another producer', async () => {
  const { store } = await ledger();
  const clock = { sample: () => ({ wallMs: 1_000, monotonicMs: 1_000 }) };
  const sessions = await LocalOsSessionAuthority.create(['s'], 600_000, clock);
  const allow = new OperationPolicyAuthorization({ load: async () => ({ schemaVersion: 1, revision: 'p', restrictions: [],
    grants: [{ id: 'all', effect: 'allow', principals: 'all', scopes: ['s'], actions: 'all', resource: { kind: 'operation', ids: 'all' } }] }) });
  let applied = 0;
  const target = { kind: 'record', identity: () => 'fixture-target', observe: async () => ({ version: null }),
    apply: async () => { applied++; return { version: '2' }; }, lookup: async () => ({ status: 'absent' as const }) };
  const app = (producer: { kind: 'principal' } | { kind: 'attempt'; identity: typeof attempt }) => new EffectApplication({ resolve: async () => descriptor },
    { resolve: () => target }, store, refuseRequiredApproval, sessions, allow, clock, { producer });
  expect(await app({ kind: 'attempt', identity: attempt }).execute(command('op-1'))).toMatchObject({ status: 'settled' });
  expect((await store.loadEffect('s', 'op-1'))!.intent.producer).toEqual({ kind: 'attempt', identity: attempt });
  // An unsettled intent: another Attempt (or a direct command) reusing its command id is a conflict, never a resume.
  const target2 = command('op-2');
  const principal = (await sessions.verifySession(undefined)).principal;
  await store.claimEffect({ ...intent('op-2'), command: target2, actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject },
    producer: { kind: 'attempt', identity: attempt } } as EffectIntent);
  await expect(app({ kind: 'attempt', identity: { ...attempt, attemptId: 'attempt-2', generation: 2 } }).execute(target2)).rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
  await expect(app({ kind: 'principal' }).execute(target2)).rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
  expect(applied).toBe(1);
});
