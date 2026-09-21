import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelInvocationStore, openSqliteProviderSpendAuditStore, openSqliteProviderSpendIntegrityReader } from '#adapters/index.js';
import { createProviderSpendAccount, createProviderSpendAuditReceipt, createProviderSpendCheckpoint,
  ProviderSpendAuditApplication } from '#engine/index.js';

const roots: string[] = [];
const options = { busyTimeoutMs: 20, journalMode: 'delete' as const, durability: 'full' as const };
const principal = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['scope'] };
const authorization = { revision: 'policy', ruleId: 'audit' };

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-provider-spend-audit-store-'));
  roots.push(root);
  const path = join(root, 'ledger.db');
  const ledger = await openSqliteModelInvocationStore(path, options, 'allow'); ledger.close();
  const account = createProviderSpendAccount({ schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 3,
    currency: 'USD', limitMinorUnits: 100 });
  const checkpoint = createProviderSpendCheckpoint(account, 1, 0);
  const db = new DatabaseSync(path);
  try {
    db.prepare('INSERT INTO provider_spend_accounts(scope_id,record,revision,reservation_count,digest) VALUES(?,?,?,?,?)')
      .run('scope', JSON.stringify(account), checkpoint.revision, checkpoint.reservationCount, checkpoint.digest);
  } finally { db.close(); }
  return { path, checkpoint };
}

function receipt(checkpoint: Awaited<ReturnType<typeof fixture>>['checkpoint'], commandId = 'audit-one', actor = principal,
  evidence = { authorization, startedAtMs: 10, completedAtMs: 20 }) {
  return createProviderSpendAuditReceipt({ command: { schemaVersion: 1, commandId, scopeId: 'scope', budgetId: 'budget',
    budgetRevision: 3, expectedCheckpointDigest: checkpoint.digest }, principal: actor, authorization: evidence.authorization,
  examinedCheckpoint: checkpoint, startedAtMs: evidence.startedAtMs, completedAtMs: evidence.completedAtMs });
}

function auditCount(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return (db.prepare('SELECT count(*) AS count FROM provider_spend_audits').get() as { count: number }).count; }
  finally { db.close(); }
}

function raceChild(path: string, value: ReturnType<typeof receipt>) {
  const child = fork(resolve('tests/fixtures/provider-spend-audit-race.mjs'),
    [path, Buffer.from(JSON.stringify(value)).toString('base64url')],
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  let resultResolve!: (value: Record<string, unknown>) => void, resultReject!: (error: Error) => void;
  const ready = new Promise<void>((accept, fail) => { readyResolve = accept; readyReject = fail; });
  const result = new Promise<Record<string, unknown>>((accept, fail) => { resultResolve = accept; resultReject = fail; });
  void ready.catch(() => {}); void result.catch(() => {});
  let readyDone = false, resultDone = false;
  const fail = (error: Error) => {
    if (!readyDone) { readyDone = true; readyReject(error); }
    if (!resultDone) { resultDone = true; resultReject(error); }
  };
  const timeout = setTimeout(() => { child.kill(); fail(new Error('AUDIT_RACE_TIMEOUT')); }, 10_000);
  child.on('message', message => {
    const value = message as { kind?: string };
    if (value.kind === 'ready' && !readyDone) { readyDone = true; readyResolve(); }
    if (value.kind === 'result' && !resultDone) { resultDone = true; resultResolve(message as Record<string, unknown>); }
  });
  child.once('error', fail);
  const exited = new Promise<void>(accept => child.once('exit', code => {
    clearTimeout(timeout);
    if (code !== 0 || !resultDone) fail(new Error(`AUDIT_RACE_EXIT_${code}`));
    accept();
  }));
  return { ready, result, go() { child.send({ kind: 'go' }, error => { if (error) fail(error); }); }, async terminate() {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  } };
}

it('migrates a schema-21 ledger forward without inventing an audit', async () => {
  const { path } = await fixture(), db = new DatabaseSync(path);
  try { db.exec('DROP TABLE provider_spend_audits; DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; PRAGMA user_version=21'); } finally { db.close(); }
  const store = await openSqliteProviderSpendAuditStore(path, options, 'allow'); store.close();
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect((check.prepare('SELECT count(*) AS count FROM provider_spend_audits').get() as { count: number }).count).toBe(0);
    expect(check.prepare("SELECT 1 FROM pragma_table_info('provider_spend_audits') WHERE name='budget_id'").get()).toBeTruthy();
    expect(check.prepare("SELECT 1 FROM pragma_index_list('provider_spend_audits') WHERE name='provider_spend_audits_budget_latest'").get()).toBeTruthy();
  } finally { check.close(); }
});

it('records, finds, and reopens one immutable receipt', async () => {
  const base = await fixture(), expected = receipt(base.checkpoint);
  const first = await openSqliteProviderSpendAuditStore(base.path, options, 'forbid');
  try { await expect(first.find('scope', 'audit-one')).resolves.toBeNull(); await expect(first.record(expected)).resolves.toEqual({ schemaVersion: 1, receipt: expected, replayed: false }); }
  finally { first.close(); }
  const second = await openSqliteProviderSpendAuditStore(base.path, options, 'forbid');
  try { await expect(second.find('scope', 'audit-one')).resolves.toEqual(expected); } finally { second.close(); }
  const check = new DatabaseSync(base.path, { readOnly: true });
  try { expect(check.prepare('SELECT budget_id,budget_revision FROM provider_spend_audits').get())
    .toEqual({ budget_id: 'budget', budget_revision: 3 }); } finally { check.close(); }
});

it('replays the original actor, policy, and timestamps for the same command', async () => {
  const base = await fixture(), expected = receipt(base.checkpoint), store = await openSqliteProviderSpendAuditStore(base.path, options, 'forbid');
  try {
    await store.record(expected);
    await expect(store.record(receipt(base.checkpoint))).resolves.toEqual({ schemaVersion: 1, receipt: expected, replayed: true });
  } finally { store.close(); }
});

it('serializes two independent writer processes to one original receipt without changing the financial checkpoint', async () => {
  const base = await fixture(), beforeDb = new DatabaseSync(base.path, { readOnly: true });
  const before = beforeDb.prepare('SELECT * FROM provider_spend_accounts WHERE scope_id=?').get('scope'); beforeDb.close();
  const first = receipt(base.checkpoint, 'audit-race', principal,
    { authorization: { revision: 'policy-a', ruleId: 'audit-a' }, startedAtMs: 10, completedAtMs: 20 });
  const second = receipt(base.checkpoint, 'audit-race', principal,
    { authorization: { revision: 'policy-b', ruleId: 'audit-b' }, startedAtMs: 30, completedAtMs: 40 });
  const children = [raceChild(base.path, first), raceChild(base.path, second)];
  let messages: Record<string, unknown>[];
  try {
    await Promise.all(children.map(child => child.ready)); children.forEach(child => child.go());
    messages = await Promise.all(children.map(child => child.result));
  } finally { await Promise.all(children.map(child => child.terminate())); }
  expect(messages.every(message => message.ok === true)).toBe(true);
  const results = messages.map(message => message.result as { replayed: boolean; receipt: typeof first });
  expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
  const winner = results.find(result => !result.replayed)!.receipt;
  expect(results.find(result => result.replayed)!.receipt).toEqual(winner);
  expect([first.digest, second.digest]).toContain(winner.digest);
  const check = new DatabaseSync(base.path, { readOnly: true });
  try {
    expect(check.prepare('SELECT count(*) AS count FROM provider_spend_audits WHERE scope_id=? AND command_id=?')
      .get('scope', 'audit-race')).toEqual({ count: 1 });
    expect(JSON.parse(String(check.prepare('SELECT record FROM provider_spend_audits WHERE scope_id=? AND command_id=?')
      .get('scope', 'audit-race')?.record))).toEqual(winner);
    expect(check.prepare('SELECT * FROM provider_spend_accounts WHERE scope_id=?').get('scope')).toEqual(before);
  } finally { check.close(); }
});

it('allows distinct commands on an unchanged checkpoint and rejects changed actor or command', async () => {
  const base = await fixture(), first = receipt(base.checkpoint), store = await openSqliteProviderSpendAuditStore(base.path, options, 'forbid');
  try {
    await store.record(first); await expect(store.record(receipt(base.checkpoint, 'audit-two'))).resolves.toMatchObject({ replayed: false });
    await expect(store.record(receipt(base.checkpoint, 'audit-one', { ...principal, id: 'other' }))).rejects
      .toMatchObject({ code: 'PROVIDER_SPEND_CONFLICT' });
    await expect(store.record({ ...first, command: { ...first.command, budgetId: 'other' } } as never)).rejects
      .toMatchObject({ code: 'PROVIDER_SPEND_CONFLICT' });
  } finally { store.close(); }
  expect(auditCount(base.path)).toBe(2);
});

it('rejects a changed checkpoint between inspection and record without creating an audit', async () => {
  const base = await fixture(), expected = receipt(base.checkpoint), next = createProviderSpendCheckpoint(base.checkpoint.account, 2, 0);
  const db = new DatabaseSync(base.path);
  try { db.prepare('UPDATE provider_spend_accounts SET record=?,revision=?,reservation_count=?,digest=? WHERE scope_id=?')
    .run(JSON.stringify(next.account), next.revision, next.reservationCount, next.digest, 'scope'); } finally { db.close(); }
  const store = await openSqliteProviderSpendAuditStore(base.path, options, 'forbid');
  try { await expect(store.record(expected)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_CONFLICT' }); } finally { store.close(); }
  expect(auditCount(base.path)).toBe(0);
});

it('rolls back a failed audit insert without changing the account', async () => {
  const base = await fixture(), expected = receipt(base.checkpoint), db = new DatabaseSync(base.path);
  let before: unknown;
  try {
    before = db.prepare('SELECT record,revision,reservation_count,digest FROM provider_spend_accounts WHERE scope_id=?').get('scope');
    db.exec("CREATE TRIGGER reject_provider_spend_audit BEFORE INSERT ON provider_spend_audits BEGIN SELECT RAISE(ABORT, 'reject'); END");
  } finally { db.close(); }
  const store = await openSqliteProviderSpendAuditStore(base.path, options, 'forbid');
  try { await expect(store.record(expected)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_UNAVAILABLE' }); } finally { store.close(); }
  const check = new DatabaseSync(base.path, { readOnly: true });
  try { expect(check.prepare('SELECT record,revision,reservation_count,digest FROM provider_spend_accounts WHERE scope_id=?').get('scope')).toEqual(before); }
  finally { check.close(); }
  expect(auditCount(base.path)).toBe(0);
});

it('rejects corrupted persisted receipt records and digests', async () => {
  const base = await fixture(), store = await openSqliteProviderSpendAuditStore(base.path, options, 'forbid');
  try { await store.record(receipt(base.checkpoint)); await store.record(receipt(base.checkpoint, 'audit-two')); } finally { store.close(); }
  const db = new DatabaseSync(base.path);
  try { db.prepare('UPDATE provider_spend_audits SET digest=? WHERE command_id=?').run('0'.repeat(64), 'audit-one');
    db.prepare('UPDATE provider_spend_audits SET record=? WHERE command_id=?').run('{', 'audit-two'); } finally { db.close(); }
  const reader = await openSqliteProviderSpendAuditStore(base.path, options, 'forbid');
  try {
    await expect(reader.find('scope', 'audit-one')).rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' });
    await expect(reader.find('scope', 'audit-two')).rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' });
  } finally { reader.close(); }
});

it('rejects SQL audit identity columns that diverge from the immutable receipt', async () => {
  const base = await fixture(), store = await openSqliteProviderSpendAuditStore(base.path, options, 'forbid');
  try { await store.record(receipt(base.checkpoint)); } finally { store.close(); }
  const db = new DatabaseSync(base.path);
  try { db.prepare('UPDATE provider_spend_audits SET budget_revision=?').run(4); } finally { db.close(); }
  const reader = await openSqliteProviderSpendAuditStore(base.path, options, 'forbid');
  try { await expect(reader.find('scope', 'audit-one')).rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' }); }
  finally { reader.close(); }
});

it('runs one engine audit through the paged SQLite reader and records the verified count', async () => {
  const base = await fixture();
  const app = new ProviderSpendAuditApplication({ async verify() { return principal; } }, { async authorize() { return authorization; } },
    () => openSqliteProviderSpendAuditStore(base.path, options, 'forbid'),
    () => openSqliteProviderSpendIntegrityReader(base.path, { busyTimeoutMs: options.busyTimeoutMs }),
    { pageSize: 1, maxReservations: 1, timeoutMs: 100, maxResultBytes: 100_000 }, () => 10, () => 0);
  const result = await app.audit(receipt(base.checkpoint).command);
  expect(result).toMatchObject({ replayed: false, receipt: { examinedCheckpoint: { reservationCount: 0, account: { reservedMinorUnits: 0 } } } });
  expect(auditCount(base.path)).toBe(1);
});

it('rejects a checkpoint changed after scan and second authorization at the real final record CAS', async () => {
  const base = await fixture(), next = createProviderSpendCheckpoint(base.checkpoint.account, 2, 0);
  const realStore = await openSqliteProviderSpendAuditStore(base.path, { ...options, busyTimeoutMs: 5_000 }, 'forbid');
  let authorizations = 0, records = 0;
  const store = { find: realStore.find.bind(realStore), close: realStore.close.bind(realStore), async record(value: ReturnType<typeof receipt>, signal?: AbortSignal) {
    records++;
    const db = new DatabaseSync(base.path);
    try { db.prepare('UPDATE provider_spend_accounts SET record=?,revision=?,reservation_count=?,digest=? WHERE scope_id=?')
      .run(JSON.stringify(next.account), next.revision, next.reservationCount, next.digest, 'scope'); }
    finally { db.close(); }
    return realStore.record(value, signal);
  } };
  const app = new ProviderSpendAuditApplication({ async verify() { return principal; } }, { async authorize() {
    authorizations++; return authorization;
  } }, async () => store, () => openSqliteProviderSpendIntegrityReader(base.path, { busyTimeoutMs: 5_000 }),
  { pageSize: 1, maxReservations: 1, timeoutMs: 5_000, maxResultBytes: 100_000 }, () => 10, () => 0);
  await expect(app.audit(receipt(base.checkpoint, 'audit-final-cas').command)).rejects
    .toMatchObject({ code: 'PROVIDER_SPEND_CONFLICT' });
  expect({ authorizations, records }).toEqual({ authorizations: 2, records: 1 });
  expect(auditCount(base.path)).toBe(0);
  const check = new DatabaseSync(base.path, { readOnly: true });
  try { expect(check.prepare('SELECT revision,digest FROM provider_spend_accounts WHERE scope_id=?').get('scope'))
    .toEqual({ revision: next.revision, digest: next.digest }); } finally { check.close(); }
});
