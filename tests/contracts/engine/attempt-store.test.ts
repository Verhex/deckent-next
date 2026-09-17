import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AttemptApplication } from '../../../src/engine/index.js';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '../../../src/adapters/index.js';
import { createAttempt, requestAttemptCancellation } from '../../../src/domain/index.js';
const options = { busyTimeoutMs: 25, journalMode: 'wal', durability: 'full' } as const;
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const verifier = { async verify(credential: unknown) { return { id: credential === 'outsider' ? 'outsider' : 'operator', issuer: 'test', subject: credential === 'outsider' ? '2' : '1', assurance: 'token-verified', scopeIds: ['customer'] }; } };
const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 'customer', layoutRevision: 'layout', generation: 1 };
const command = (commandId: string, action: object) => ({ schemaVersion: 2, commandId, scopeId: 'customer', action });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deckent-attempt-store-')); roots.push(root);
  const path = join(root, 'execution.db'); const store = await openSqliteAttemptStore(path, options); stores.push(store);
  const app = new AttemptApplication(store, { async authorize(_input, principal) { if (principal.id !== 'operator') throw new Error('DENIED'); } }, verifier);
  return { path, store, app };
}
describe('application and real SQLite attempt store', () => {
  it('persists evidence and replays old commands after restart without reverting newer state', async () => {
    const f = await fixture();
    const create = command('create', { kind: 'create', identity });
    await f.app.execute(create, 'private-bearer');
    expect((await f.store.receipt('customer', 'create'))!.command).not.toContain('private-bearer');
    const observe = command('observe', { kind: 'observe', observation: { protocolVersion: 1, identity, sequence: 1, eventId: 'e1', result: { kind: 'started' } } });
    await f.app.execute(observe);
    await f.app.execute(command('cancel', { kind: 'cancel', attemptId: 'a' }));
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const store = await openSqliteAttemptStore(f.path, options); stores.push(store);
    const app = new AttemptApplication(store, { async authorize() {} }, verifier);
    expect((await app.execute(observe)).snapshot.revision).toBe(1);
    expect((await store.load('customer', 'a'))!.revision).toBe(2);
    expect((await app.execute(create)).snapshot.revision).toBe(0);
  });
  it('rejects payload substitution and checks authorization even for replay', async () => {
    const f = await fixture(); const create = command('x', { kind: 'create', identity }); await f.app.execute(create);
    await expect(f.app.execute(command('x', { kind: 'cancel', attemptId: 'a' }))).rejects.toThrow('ATTEMPT_COMMAND_CONFLICT');
    await expect(f.app.execute(create, 'outsider')).rejects.toThrow('DENIED');
    expect(await f.store.load('foreign', 'a')).toBeNull(); expect(await f.store.receipt('foreign', 'x')).toBeNull();
  });
  it('atomically rejects stale revisions across independent connections', async () => {
    const f = await fixture(); await f.app.execute(command('create', { kind: 'create', identity }));
    const other = await openSqliteAttemptStore(f.path, options); stores.push(other);
    const next = requestAttemptCancellation(createAttempt(identity), 0);
    const outcomes = await Promise.allSettled([f.store.commit({ commandId: 'one', command: 'one', expectedRevision: 0, snapshot: next }),
      other.commit({ commandId: 'two', command: 'two', expectedRevision: 0, snapshot: next })]);
    expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(await other.receipt('customer', 'two')).toBeNull();
  });
  it('rolls back snapshot mutation when the receipt write fails', async () => {
    const f = await fixture(); await f.app.execute(command('create', { kind: 'create', identity }));
    const db = new DatabaseSync(f.path);
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON attempt_receipts BEGIN SELECT RAISE(ABORT, 'injected failure'); END"); db.close();
    await expect(f.app.execute(command('cancel', { kind: 'cancel', attemptId: 'a' }))).rejects.toThrow('injected failure');
    expect((await f.store.load('customer', 'a'))!.revision).toBe(0);
    expect(await f.store.receipt('customer', 'cancel')).toBeNull();
  });
  it('rejects unsupported storage versions without rewriting them', async () => {
    const f = await fixture(); const db = new DatabaseSync(f.path); db.exec('PRAGMA user_version=99'); db.close();
    await expect(openSqliteAttemptStore(f.path, options)).rejects.toThrow('ATTEMPT_STORE_VERSION');
  });
  it('converges duplicate application commands without double transitions', async () => {
    const f = await fixture();
    const create = command('create', { kind: 'create', identity });
    const receipts = await Promise.all(Array.from({ length: 8 }, () => f.app.execute(create)));
    expect(receipts.every(receipt => receipt.snapshot.revision === 0)).toBe(true);
    const cancel = command('cancel', { kind: 'cancel', attemptId: 'a' });
    const cancelled = await Promise.all(Array.from({ length: 8 }, () => f.app.execute(cancel)));
    expect(cancelled.every(receipt => receipt.snapshot.revision === 1)).toBe(true);
    expect((await f.store.load('customer', 'a'))!.revision).toBe(1);
  });
  it('rejects identity replacement and changed content with no revision increment', async () => {
    const f = await fixture(); await f.app.execute(command('create', { kind: 'create', identity }));
    const current = createAttempt(identity);
    await expect(f.store.commit({ commandId: 'bad', command: 'bad', expectedRevision: 0,
      snapshot: { ...current, cancelRequested: true } })).rejects.toThrow('ATTEMPT_STORE_CONFLICT');
    await expect(f.store.commit({ commandId: 'bad2', command: 'bad2', expectedRevision: 0,
      snapshot: { ...current, revision: 1, identity: { ...identity, generation: 2 } } })).rejects.toThrow('ATTEMPT_STORE_CONFLICT');
  });

});
