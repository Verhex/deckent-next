import { admitRunAttempts } from '../support/admission.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir, chmod, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteInventoryReader } from '#adapters/index.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function path() { const root = await mkdtemp(join(tmpdir(), 'deckent-reader-')); roots.push(root); return join(root, 'ledger.db'); }
const query = { schemaVersion: 1 as const, scopeId: 's', after: null, limit: 2 };
it('does not create missing ledgers or migrate unsupported schemas', async () => {
  const file = await path();
  await expect(openSqliteInventoryReader(file, { busyTimeoutMs: 20 })).rejects.toThrow();
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const version of [0, 1, 99]) {
    const db = new DatabaseSync(file); db.exec(`DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=${version}`); db.close();
    const before = await readFile(file);
    await expect(openSqliteInventoryReader(file, { busyTimeoutMs: 20 })).rejects.toThrow('ATTEMPT_STORE_VERSION');
    expect(await readFile(file)).toEqual(before);
  }
});
it('observes committed WAL updates while exposing no write operations', async () => {
  const file = await path();
  const writer = await openSqliteAttemptStore(file, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles);
  const reader = await openSqliteInventoryReader(file, { busyTimeoutMs: 20 });
  try {
    expect((await reader.listDispatches(query)).entries).toEqual([]);
    const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
    await admitRunAttempts(writer, [identity]);
    await writer.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: '/workspace', argv: ['tool'] } }));
    expect((await reader.listDispatches(query)).entries[0]!.identity).toEqual(identity);
    expect('commit' in reader).toBe(false); expect('claimDispatch' in reader).toBe(false);
    const probe = new DatabaseSync(file, { readOnly: true });
    try { expect(probe.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal'); } finally { probe.close(); }
  } finally { reader.close(); writer.close(); }
});
it('leaves DELETE-journal database bytes unchanged after inspection', async () => {
  const file = await path();
  const writer = await openSqliteAttemptStore(file, { busyTimeoutMs: 20, journalMode: 'delete', durability: 'full' }, 'allow', custodyProfiles); writer.close();
  const before = await readFile(file); const reader = await openSqliteInventoryReader(file, { busyTimeoutMs: 20 });
  try { expect((await reader.listDispatches(query)).entries).toEqual([]); } finally { reader.close(); }
  expect(await readFile(file)).toEqual(before);
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports missing WAL shared memory on a read-only directory without ignoring committed WAL', async () => {
  const file = await path();
  const writer = await openSqliteAttemptStore(file, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles);
  const directory = file + '-readonly'; await mkdir(directory, { mode: 0o700 }); const copy = join(directory, 'ledger.db');
  try {
    const identity = { runId: 'r', taskId: 't', attemptId: 'wal-only', scopeId: 's', layoutRevision: 'l', generation: 1 };
    await admitRunAttempts(writer, [identity]);
    await writer.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: '/workspace', argv: ['tool'] } }));
    // Quiescent writer, copy both files while the connection retains uncheckpointed WAL.
    await copyFile(file, copy); await copyFile(file + '-wal', copy + '-wal');
  } finally { writer.close(); }
  await chmod(copy, 0o400); await chmod(copy + '-wal', 0o400); await chmod(directory, 0o500);
  try {
    await expect(openSqliteInventoryReader(copy, { busyTimeoutMs: 20 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_READ_UNAVAILABLE' });
    await expect(stat(copy + '-shm')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await chmod(directory, 0o700); }
  // Re-enable SQLite bookkeeping: the committed record must be visible, not silently dropped.
  const reader = await openSqliteInventoryReader(copy, { busyTimeoutMs: 20 });
  try { expect((await reader.listDispatches(query)).entries[0]!.identity.attemptId).toBe('wal-only'); } finally { reader.close(); }
});

it('distinguishes invalid database bytes and damaged schema pages from read-access failures', async () => {
  const file = await path(); await writeFile(file, 'not a SQLite database');
  await expect(openSqliteInventoryReader(file, { busyTimeoutMs: 20 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_CORRUPT' });
  await rm(file); const writer = await openSqliteAttemptStore(file, { busyTimeoutMs: 20, journalMode: 'delete', durability: 'full' }, 'allow', custodyProfiles); writer.close();
  const bytes = await readFile(file); bytes[100] = 0; await writeFile(file, bytes);
  let reader;
  try { reader = await openSqliteInventoryReader(file, { busyTimeoutMs: 20 }); await expect(reader.listDispatches(query)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_CORRUPT' }); }
  catch (error) { expect(error).toMatchObject({ code: 'ATTEMPT_STORE_CORRUPT' }); }
  finally { reader?.close(); }
});
