import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { targetQueueRequestSchema, type TargetQueueRecord } from '#domain/index.js';
import { targetQueueKey, TargetQueueApplication, AuditApplication, type TargetQueueAudit } from '#engine/index.js';
import { SqliteTargetQueue } from '#adapters/core/target-queue-store/index.js';
import { migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { createHmacIntegrity } from '#platform/index.js';
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const bounds = { capacity: 8, perTarget: 4, activeTargets: 2, batchSize: 2, batchWindowMs: 100, leaseMs: 1000, verificationTimeoutMs: 1000, revalidations: 2 };
const actor = { id: 'human', issuer: 'test', subject: 'owner' };
const principal = { ...actor, assurance: 'os-user', scopeIds: ['s'], roles: [] } as const;
const integrity = createHmacIntegrity('audit-test', randomBytes(32));
const audit: TargetQueueAudit = (store, record) => { new AuditApplication(store, integrity).record({ schemaVersion: 1,
  eventId: record.request.commandId + '-' + record.revision, scopeId: record.request.identity.scopeId, principal: { issuer: actor.issuer, subject: actor.subject },
  policyRevision: 'p1', atMs: 1, subject: { kind: 'target-queue', commandId: record.request.commandId, targetKey: record.key,
    ordinal: record.ordinal, revision: record.revision, state: record.state, payloadDigest: record.request.payloadDigest,
    recordDigest: createHash('sha256').update(JSON.stringify(record)).digest('hex') } }); };
function request(id: string, resource = 'a'.repeat(64), scopeId = 's') {
  return targetQueueRequestSchema.parse({ schemaVersion: 1, commandId: id, identity: { scopeId, runId: 'r', taskId: 't', attemptId: id, generation: 1, layoutRevision: 'l' },
    actor, target: { schemaVersion: 1, installationId: 'i', adapter: { id: 'adapter', version: 1 }, resourceBinding: resource, target: { kind: 'record', id: 'same-address' } },
    payloadDigest: 'b'.repeat(64), policyRevision: 'p1', outputDigest: 'c'.repeat(64), acceptedRevision: 1, submittedAt: 1, deadline: 5000 });
}
function fixture() {
  const db = new DatabaseSync(':memory:'); dbs.push(db); migrateLedger(db, 'allow');
  const store = new SqliteTargetQueue(db), app = new TargetQueueApplication(store, { async authorize() {}, async validate() {} }, bounds, audit);
  return { db, store, app };
}
describe('durable target queue', () => {
  it('accounts for concurrent admission, FIFO ownership and exact replay without duplicate audits', async () => {
    const f = fixture(), input = request('one');
    const records = await Promise.all([f.app.submit(input, principal as never), f.app.submit(request('two'), principal as never), f.app.submit(input, principal as never)]);
    expect(records.map(r => r.ordinal)).toEqual([1, 2, 1]);
    expect(f.db.prepare('SELECT count(*) AS n FROM audit_events').get()?.n).toBe(2);
    expect(() => f.app.claim(records[1]!, 'service', 2)).toThrow('QUEUE_TARGET_BUSY');
    const claimed = f.app.claim(records[0]!, 'service', 2);
    expect(claimed).toMatchObject({ state: 'revalidating', epoch: 1, ownerInstance: 'service' });
    expect(() => f.app.claim(records[0]!, 'other-service', 99999)).toThrow();
    await expect(f.app.submit({ ...input, payloadDigest: 'd'.repeat(64) }, principal as never)).rejects.toThrow('QUEUE_CONFLICT');
  });
  it('reserves the same-scope FIFO prefix under one epoch atomically, with rollback on audit failure', () => {
    const f = fixture(), first = f.store.enqueue(request('one'), bounds, audit);
    f.store.enqueue(request('two'), bounds, audit); f.store.enqueue(request('foreign', undefined, 'other'), bounds, audit);
    let count = 0;
    expect(() => f.store.reserve(first, 'service', 2, bounds, (store, record) => { audit(store, record); if (++count === 2) throw new Error('audit-lost'); })).toThrow('audit-lost');
    expect(f.store.load('s', 'one')).toEqual(first); expect(f.store.load('s', 'two')?.state).toBe('queued');
    const batch = f.app.reserve(first, 'service', 2);
    expect(batch.map(row => [row.request.commandId, row.epoch, row.ownerInstance])).toEqual([['one', 1, 'service'], ['two', 1, 'service']]);
    expect(f.store.load('other', 'foreign')?.state).toBe('queued');
    expect(() => f.app.reserve(first, 'other', 2)).toThrow('QUEUE_TARGET_BUSY');
  });
  it('separates physical resources and shares one FIFO across scopes on the same physical target', () => {
    const f = fixture(), a = f.store.enqueue(request('one'), bounds, audit);
    const b = f.store.enqueue(request('two', 'd'.repeat(64)), bounds, audit);
    const c = f.store.enqueue(request('three', 'a'.repeat(64), 'other-scope'), bounds, audit);
    expect([a.ordinal, b.ordinal, c.ordinal]).toEqual([1, 1, 2]); expect(a.key).not.toBe(b.key); expect(a.key).toBe(c.key);
    expect(f.store.list('s', null, 8).map(r => r.request.commandId)).toEqual(['one', 'two']);
    expect(f.store.head(targetQueueKey(a.request.target))).toEqual(a);
  });
  it('refuses full backlog and scope/actor spoofing without assigning a position', async () => {
    const f = fixture(); for (let i = 0; i < bounds.perTarget; i++) f.store.enqueue(request('c' + i), bounds, audit);
    await expect(f.app.submit(request('extra'), principal as never)).rejects.toThrow('QUEUE_CAPACITY');
    await expect(f.app.submit(request('foreign', undefined, 'another'), principal as never)).rejects.toThrow('QUEUE_AUTHORITY_REQUIRED');
    await expect(f.app.submit({ ...request('forged'), actor: { ...actor, id: 'attacker' } }, principal as never)).rejects.toThrow('QUEUE_AUTHORITY_REQUIRED');
    expect(f.db.prepare('SELECT count(*) AS n FROM target_queue').get()?.n).toBe(bounds.perTarget);
  });
  it('rolls back enqueue and transition when sealed audit cannot persist', () => {
    const f = fixture(), broken = () => { throw new Error('audit-unavailable'); };
    expect(() => f.store.enqueue(request('one'), bounds, broken)).toThrow('audit-unavailable');
    expect(f.store.head(targetQueueKey(request('one').target))).toBeNull();
    const r = f.store.enqueue(request('one'), bounds, audit);
    expect(() => f.store.change(r, { ...r, revision: 1, state: 'revalidating', ownerInstance: 'service', epoch: 1, leaseDeadline: 100 }, bounds, broken)).toThrow('audit-unavailable');
    expect(f.store.load('s', 'one')).toEqual(r);
    expect(f.db.prepare('SELECT count(*) AS n FROM target_queue_events').get()?.n).toBe(1);
    expect(() => f.db.exec('DELETE FROM target_queue_events')).toThrow('QUEUE_APPEND_ONLY');
  });
  it('retains interrupted ownership across application recreation and refuses unknown-effect bypass', () => {
    const f = fixture(), first = f.store.enqueue(request('one'), bounds, audit);
    const held = f.app.claim(first, 'old-service', 2);
    const restarted = new TargetQueueApplication(f.store, { async authorize() {}, async validate() {} }, bounds, audit);
    expect(() => restarted.claim(held, 'new-service', 99999)).toThrow('QUEUE_CONFLICT');
    // Seed a retained effect-unknown point to exercise the database CAS, independently of the effect writer.
    const unknown: TargetQueueRecord = { ...held, state: 'reconciling' };
    f.db.prepare('UPDATE target_queue SET state=?,record=? WHERE command_id=?').run(unknown.state, JSON.stringify(unknown), 'one');
    const next = f.store.enqueue(request('two'), bounds, audit);
    expect(() => restarted.claim(next, 'new-service', 99999)).toThrow();
    expect(f.store.head(first.key)?.state).toBe('reconciling');
  });
  it('advances the durable target epoch across tickets and enforces active-target capacity', () => {
    const f = fixture(), first = f.store.enqueue(request('one'), bounds, audit), second = f.store.enqueue(request('two'), bounds, audit);
    const held = f.app.claim(first, 'service', 2); f.app.transition(held, { state: 'parked' });
    expect(f.app.claim(second, 'service', 3).epoch).toBe(2);
    const foreign = f.store.enqueue(request('foreign', 'e'.repeat(64)), bounds, audit);
    f.app.claim(foreign, 'service', 3);
    const third = f.store.enqueue(request('third', 'f'.repeat(64)), bounds, audit);
    expect(() => f.app.claim(third, 'service', 3)).toThrow('QUEUE_CAPACITY');
    expect(f.store.load('s', 'third')?.state).toBe('queued');
  });
  it('holds historical unsettled effects whose source binding cannot be backfilled', () => {
    const f = fixture();
    f.db.prepare('INSERT INTO workspace_adoptions VALUES(?,?,?,?,?,?,?)').run('s', 'legacy', 'same-address', 1, 'adopt', '{}', 0);
    expect(() => f.store.enqueue(request('one'), bounds, audit)).toThrow('QUEUE_RECOVERY_REQUIRED');
    expect(f.store.load('s', 'one')).toBeNull();
  });
});
