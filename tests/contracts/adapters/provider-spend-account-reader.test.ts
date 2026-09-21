import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelInvocationStore, openSqliteProviderSpendAccountReader,
  openSqliteProviderSpendAuditStore } from '#adapters/index.js';
import { createProviderSpendAuditReceipt, createProviderSpendCheckpoint, parseProviderSpendAccount } from '#engine/index.js';

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
const query = { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'budget', budgetRevision: 1 };
const principal = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['scope'] };
function receipt(value: ReturnType<typeof checkpoint>, commandId = 'audit') {
  return createProviderSpendAuditReceipt({ command: { ...query, commandId, expectedCheckpointDigest: value.digest },
    principal, authorization: { revision: 'policy', ruleId: 'audit' }, examinedCheckpoint: value,
    startedAtMs: 1, completedAtMs: 2 });
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
  const before = await readFile(path);
  const reader = await openSqliteProviderSpendAccountReader(path, readerOptions);
  try {
    await expect(reader.loadSnapshot(query)).resolves.toEqual({ checkpoint: expected, audit: null });
  } finally { reader.close(); }
  await expect(readFile(path)).resolves.toEqual(before);
});

it('returns null for an empty current spend ledger', async () => {
  const reader = await openSqliteProviderSpendAccountReader(await ledger(), readerOptions);
  try { await expect(reader.loadSnapshot(query)).resolves.toEqual({ checkpoint: null, audit: null }); } finally { reader.close(); }
});

it('rejects invalid scopes and strict reader options', async () => {
  const path = await ledger(), reader = await openSqliteProviderSpendAccountReader(path, readerOptions);
  try { await expect(reader.loadSnapshot({ ...query, scopeId: '' })).rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' }); } finally { reader.close(); }
  await expect(openSqliteProviderSpendAccountReader(path, { busyTimeoutMs: -1 })).rejects
    .toMatchObject({ code: 'PROVIDER_SPEND_INVALID' });
  await expect(openSqliteProviderSpendAccountReader(path, { busyTimeoutMs: 1, extra: true } as never)).rejects
    .toMatchObject({ code: 'PROVIDER_SPEND_INVALID' });
});

it('rejects a corrupted checkpoint digest as invalid', async () => {
  const path = await ledger(); await persist(path);
  const db = new DatabaseSync(path); db.prepare('UPDATE provider_spend_accounts SET digest=? WHERE scope_id=?').run('0'.repeat(64), 'scope'); db.close();
  const reader = await openSqliteProviderSpendAccountReader(path, readerOptions);
  try { await expect(reader.loadSnapshot(query)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' }); } finally { reader.close(); }
});

it('atomically projects the latest exact-budget audit as current then stale after checkpoint advance', async () => {
  const path = await ledger(), audited = await persist(path), store = await openSqliteProviderSpendAuditStore(path, writerOptions, 'forbid');
  const expected = receipt(audited);
  try { await store.record(expected); } finally { store.close(); }
  let reader = await openSqliteProviderSpendAccountReader(path, readerOptions);
  try { await expect(reader.loadSnapshot(query)).resolves.toEqual({ checkpoint: audited, audit: expected }); } finally { reader.close(); }
  const advanced = createProviderSpendCheckpoint(audited.account, 5, 3), db = new DatabaseSync(path);
  try { db.prepare('UPDATE provider_spend_accounts SET revision=?,digest=? WHERE scope_id=?').run(advanced.revision, advanced.digest, 'scope'); }
  finally { db.close(); }
  reader = await openSqliteProviderSpendAccountReader(path, readerOptions);
  try { await expect(reader.loadSnapshot(query)).resolves.toEqual({ checkpoint: advanced, audit: expected }); } finally { reader.close(); }
});

it('rejects malformed audit JSON and SQL identity divergence', async () => {
  const path = await ledger(), audited = await persist(path), store = await openSqliteProviderSpendAuditStore(path, writerOptions, 'forbid');
  try { await store.record(receipt(audited)); } finally { store.close(); }
  const db = new DatabaseSync(path);
  try { db.prepare('UPDATE provider_spend_audits SET budget_id=?').run('other'); } finally { db.close(); }
  const reader = await openSqliteProviderSpendAccountReader(path, readerOptions);
  try { await expect(reader.loadSnapshot({ ...query, budgetId: 'other' })).rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' }); }
  finally { reader.close(); }
});

it('uses the exact budget-revision latest index instead of scanning audit history', async () => {
  const path = await ledger(), db = new DatabaseSync(path, { readOnly: true });
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT scope_id,budget_id,budget_revision,command_id,record,digest
      FROM provider_spend_audits WHERE scope_id=? AND budget_id=? AND budget_revision=?
      ORDER BY sequence DESC LIMIT 1`).all('scope', 'budget', 1) as Array<{ detail: string }>;
    expect(plan.some(row => row.detail.includes('SEARCH provider_spend_audits USING INDEX provider_spend_audits_budget_latest'))).toBe(true);
    expect(plan.every(row => !row.detail.startsWith('SCAN provider_spend_audits'))).toBe(true);
  } finally { db.close(); }
});

it('rejects an old ledger without changing its bytes', async () => {
  const path = await ledger(), db = new DatabaseSync(path); db.exec('DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=20'); db.close();
  const before = await readFile(path);
  await expect(openSqliteProviderSpendAccountReader(path, readerOptions)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  await expect(readFile(path)).resolves.toEqual(before);
});

it('rejects a genuine schema-21 ledger without an audit table or changing bytes', async () => {
  const path = await ledger(), db = new DatabaseSync(path);
  try { db.exec('DROP TABLE provider_spend_audits; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=21'); } finally { db.close(); }
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
