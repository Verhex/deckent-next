import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteInventoryReader } from '#adapters/index.js';
import { createAttempt } from '#domain/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function path() { const root = await mkdtemp(join(tmpdir(), 'deckent-reader-')); roots.push(root); return join(root, 'ledger.db'); }
const query = { schemaVersion: 1 as const, scopeId: 's', after: null, limit: 2 };
it('does not create missing ledgers or migrate unsupported schemas', async () => {
  const file = await path();
  await expect(openSqliteInventoryReader(file, { busyTimeoutMs: 20 })).rejects.toThrow();
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const version of [0, 1, 99]) {
    const db = new DatabaseSync(file); db.exec(`PRAGMA user_version=${version}`); db.close();
    const before = await readFile(file);
    await expect(openSqliteInventoryReader(file, { busyTimeoutMs: 20 })).rejects.toThrow('ATTEMPT_STORE_VERSION');
    expect(await readFile(file)).toEqual(before);
  }
});
it('observes committed WAL updates while exposing no write operations', async () => {
  const file = await path();
  const writer = await openSqliteAttemptStore(file, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' });
  const reader = await openSqliteInventoryReader(file, { busyTimeoutMs: 20 });
  try {
    expect((await reader.listDispatches(query)).entries).toEqual([]);
    const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
    await writer.commit({ commandId: 'admit', command: 'admit', expectedRevision: null, snapshot: createAttempt(identity) });
    await writer.claimDispatch({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: '/workspace', argv: ['tool'] } });
    expect((await reader.listDispatches(query)).entries[0]!.identity).toEqual(identity);
    expect('commit' in reader).toBe(false); expect('claimDispatch' in reader).toBe(false);
    const probe = new DatabaseSync(file, { readOnly: true });
    try { expect(probe.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal'); } finally { probe.close(); }
  } finally { reader.close(); writer.close(); }
});
it('leaves DELETE-journal database bytes unchanged after inspection', async () => {
  const file = await path();
  const writer = await openSqliteAttemptStore(file, { busyTimeoutMs: 20, journalMode: 'delete', durability: 'full' }); writer.close();
  const before = await readFile(file); const reader = await openSqliteInventoryReader(file, { busyTimeoutMs: 20 });
  try { expect((await reader.listDispatches(query)).entries).toEqual([]); } finally { reader.close(); }
  expect(await readFile(file)).toEqual(before);
});
