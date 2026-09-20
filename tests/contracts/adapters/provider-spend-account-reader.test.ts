import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelInvocationStore, openSqliteProviderSpendAccountReader } from '#adapters/index.js';
import { createProviderSpendCheckpoint, parseProviderSpendAccount } from '#engine/index.js';

const roots: string[] = [];
const writerOptions = { busyTimeoutMs: 20, journalMode: 'delete' as const, durability: 'full' as const };
const readerOptions = { busyTimeoutMs: 20 };

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function ledger() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-provider-spend-account-reader-'));
  roots.push(root);
  const path = join(root, 'ledger.db');
  const store = await openSqliteModelInvocationStore(path, writerOptions, 'allow');
  store.close();
  return path;
}

function checkpoint(scopeId = 'scope') {
  const account = parseProviderSpendAccount({ schemaVersion: 2, budget: { schemaVersion: 1, scopeId,
    budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 100 }, reservedMinorUnits: 7,
  settledMinorUnits: 2, settledExactMinorUnits: '1.25', frozen: false });
  return createProviderSpendCheckpoint(account, 4, 3);
}

async function persist(path: string, value = checkpoint()) {
  const db = new DatabaseSync(path);
  try {
    db.prepare('INSERT INTO provider_spend_accounts(scope_id,record,revision,reservation_count,digest) VALUES(?,?,?,?,?)')
      .run(value.account.budget.scopeId, JSON.stringify(value.account), value.revision, value.reservationCount, value.digest);
  } finally { db.close(); }
  return value;
}

it('loads one exact persisted account checkpoint without exposing invocation history', async () => {
  const path = await ledger(), expected = await persist(path);
  const reader = await openSqliteProviderSpendAccountReader(path, readerOptions);
  try {
    await expect(reader.loadSnapshot('scope')).resolves.toEqual(expected);
  } finally { reader.close(); }
});

it('returns null for an empty current spend ledger', async () => {
  const reader = await openSqliteProviderSpendAccountReader(await ledger(), readerOptions);
  try { await expect(reader.loadSnapshot('scope')).resolves.toBeNull(); } finally { reader.close(); }
});

it('rejects invalid scopes and strict reader options', async () => {
  const path = await ledger(), reader = await openSqliteProviderSpendAccountReader(path, readerOptions);
  try { await expect(reader.loadSnapshot('')).rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' }); } finally { reader.close(); }
  await expect(openSqliteProviderSpendAccountReader(path, { busyTimeoutMs: -1 })).rejects
    .toMatchObject({ code: 'PROVIDER_SPEND_INVALID' });
  await expect(openSqliteProviderSpendAccountReader(path, { busyTimeoutMs: 1, extra: true } as never)).rejects
    .toMatchObject({ code: 'PROVIDER_SPEND_INVALID' });
});

it('rejects a corrupted checkpoint digest as invalid', async () => {
  const path = await ledger(); await persist(path);
  const db = new DatabaseSync(path); db.prepare('UPDATE provider_spend_accounts SET digest=? WHERE scope_id=?').run('0'.repeat(64), 'scope'); db.close();
  const reader = await openSqliteProviderSpendAccountReader(path, readerOptions);
  try { await expect(reader.loadSnapshot('scope')).rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' }); } finally { reader.close(); }
});

it('rejects an old ledger without changing its bytes', async () => {
  const path = await ledger(), db = new DatabaseSync(path); db.exec('PRAGMA user_version=20'); db.close();
  const before = await readFile(path);
  await expect(openSqliteProviderSpendAccountReader(path, readerOptions)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  await expect(readFile(path)).resolves.toEqual(before);
});

it('does not create a missing database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-provider-spend-account-reader-missing-'));
  roots.push(root);
  const path = join(root, 'missing.db');
  await expect(openSqliteProviderSpendAccountReader(path, readerOptions)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_UNAVAILABLE' });
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
