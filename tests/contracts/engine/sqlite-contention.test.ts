import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { createAttempt } from '#domain/index.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = []; const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup(journalMode: 'wal' | 'delete' = 'wal', lock: 'write' | 'read' = 'write') {
  const root = await mkdtemp(join(tmpdir(), 'deckent-contention-')); roots.push(root); const path = join(root, 'state.db');
  const options = { busyTimeoutMs: 40, journalMode, durability: 'full' } as const;
  const store = await openSqliteAttemptStore(path, options); stores.push(store);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    if(process.argv[2]==='read'){db.exec('BEGIN');db.prepare('SELECT * FROM attempts').all();}
    else db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked'); process.stdin.once('data',()=>{db.exec('ROLLBACK');db.close();process.exit(0);});
  `, path, lock], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => reject(new Error('lock-holder-exited:'+code)));
    child.stdout.once('data', data => String(data) === 'locked' ? resolve() : reject(new Error('lock-protocol-invalid')));
  });
  return { path, store, child, options };
}
describe('separate-process SQLite lock contention', () => {
  it('returns typed bounded busy and accepts the same command after the holder releases', async () => {
    const f = await setup();
    const input = { commandId: 'create', command: 'create', expectedRevision: null,
      snapshot: createAttempt({ runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'v' }) };
    const started = performance.now();
    await expect(f.store.commit(input)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_BUSY' });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(await f.store.load('s', 'a')).toBeNull(); expect(await f.store.receipt('s', 'create')).toBeNull();
    await expect(openSqliteAttemptStore(f.path, f.options)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_BUSY' });
    const closed = once(f.child, 'close'); f.child.stdin.write('release'); await closed;
    const receipt = await f.store.commit(input); expect(receipt.snapshot.revision).toBe(0);
    expect(await f.store.commit(input)).toEqual(receipt);
  });
  it('rejects invalid budgets before opening a database', async () => {
    for (const busyTimeoutMs of [-1, Infinity, 2.5, 2_147_483_648]) {
      await expect(openSqliteAttemptStore(':memory:', { busyTimeoutMs, journalMode: 'wal', durability: 'full' })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_OPTIONS' });
    }
  });
  it.each(['delete', 'wal'] as const)('handles a reader during %s commit without inventing lost writes', async journalMode => {
    const f = await setup(journalMode, 'read');
    const input = { commandId: 'create', command: 'create', expectedRevision: null,
      snapshot: createAttempt({ runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'v' }) };
    if (journalMode === 'delete') {
      // The reader allows BEGIN IMMEDIATE and INSERT, but prevents the exclusive lock at COMMIT.
      await expect(f.store.commit(input)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_BUSY' });
      expect(await f.store.load('s', 'a')).toBeNull();
      expect(await f.store.receipt('s', 'create')).toBeNull();
    } else {
      // A WAL reader pins its own snapshot; it does not prevent this writer from committing.
      expect((await f.store.commit(input)).snapshot.revision).toBe(0);
    }
    const closed = once(f.child, 'close'); f.child.stdin.write('release'); await closed;
    expect((await f.store.commit(input)).snapshot.revision).toBe(0);
    expect((await f.store.load('s', 'a'))!.revision).toBe(0);
  });

});
