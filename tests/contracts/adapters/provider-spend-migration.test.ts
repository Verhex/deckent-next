import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { CURRENT_LEDGER_VERSION, MODEL_ALLOCATION_LEDGER_VERSION, PROVIDER_SPEND_LEDGER_VERSION,
  migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';

const roots: string[] = [];
const options = { busyTimeoutMs: 20, journalMode: 'delete' as const, durability: 'full' as const };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function path() { const root = await mkdtemp(join(tmpdir(), 'deckent-provider-spend-migration-')); roots.push(root); return join(root, 'ledger.db'); }
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' as const };

async function seedLedger18(file: string) {
  const activations = await openSqliteModelActivationStore(file, options);
  const activation = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  activations.close();
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'openai-chat-http', version: 3, definition: { endpoint: 'http://127.0.0.1:1/', maxOutputTokens: 1,
      authentication: { type: 'none' } } }, allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 1 },
    limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'catalog',
    expectedBinding: binding, nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: 'prompt' }] } };
  const store = await openSqliteModelInvocationStore(file, options, 'allow');
  await store.claim({ command, requestDigest: modelInvocationRequestDigest(command), actor,
    authorization: { revision: 'policy', ruleId: 'invoke' }, definition, activation: activation.receipt.record, profile,
    profileDigest: modelInvocationProfileDigest(profile), invocationId: 'invocation', claimedAtMs: 2,
    spending: { budget: { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 10 },
      quote: { schemaVersion: 1, scopeId: 'scope', requestDigest: modelInvocationRequestDigest(command), profileDigest: modelInvocationProfileDigest(profile),
        pricing: { id: 'price', version: 1, digest: '291f395a66cb728f57612b09b06f9512815b982e9a5d65e3fafec28256ff0aa9', definition: { schemaVersion: 1, kind: 'synthetic-price' } },
        meter: { id: 'meter', version: 1, evidenceDigest: '446658cc1c39184b672f423a7f970bffab0e8f38e851c5b5dacd3f38eb85051f', evidence: { schemaVersion: 1, kind: 'synthetic-meter' } },
        currency: 'USD', maxChargeMinorUnits: 4 } } });
  store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec(`DROP TABLE model_invocation_allocation_checkpoints; DROP INDEX model_invocations_allocation_identity;
      DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts;
      DROP TABLE provider_spend_audits; DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=18;`);
  } finally { db.close(); }
}
function historicalHash(prefix: string, value: unknown) {
  return createHash('sha256').update(`${prefix}\n${JSON.stringify(value)}`).digest('hex');
}
type HistoricalTerminalState = 'settled-local' | 'released-not-sent' | 'held-unknown' | 'held-overrun';
function setLedger20TerminalState(file: string, state: HistoricalTerminalState) {
  const db = new DatabaseSync(file);
  try {
    const invocationRow = db.prepare(`SELECT i.scope_id,i.invocation_id,i.record FROM model_invocations i
      JOIN model_invocation_spend_reservations s ON s.scope_id=i.scope_id AND s.invocation_id=i.invocation_id`).get() as
      { scope_id: string; invocation_id: string; record: string };
    const reservationRow = db.prepare('SELECT record FROM model_invocation_spend_reservations WHERE scope_id=? AND invocation_id=?')
      .get(invocationRow.scope_id, invocationRow.invocation_id) as { record: string };
    const accountRow = db.prepare('SELECT revision,reservation_count,record FROM provider_spend_accounts WHERE scope_id=?')
      .get(invocationRow.scope_id) as { revision: number; reservation_count: number; record: string };
    const receipt = JSON.parse(invocationRow.record) as Record<string, unknown>;
    const descriptor = { schemaVersion: 1, kind: 'native-response', encoding: 'canonical-json',
      digest: 'a'.repeat(64), byteLength: 2 };
    const outcome = state === 'released-not-sent'
      ? { schemaVersion: 4, state: 'not-sent', reason: 'cancelled-before-permission', cancellationCommandId: 'cancel', observedAtMs: 4, content: null }
      : state === 'held-unknown'
      ? { schemaVersion: 4, state: 'unknown', reason: 'transport-error', evidence: null, content: null, observedAtMs: 4 }
      : { schemaVersion: 4, state: 'responded', content: descriptor, observedAtMs: 4 };
    const nextReceipt = { ...receipt, outcome };
    const reservation = JSON.parse(reservationRow.record) as Record<string, unknown>;
    const disposition = state === 'settled-local'
      ? { state: 'settled-local', amountMinorUnits: 3, evidenceDigest: historicalHash('deckent.provider-spend-outcome.v1', outcome) }
      : state === 'released-not-sent'
      ? { state: 'released-not-sent', evidenceDigest: historicalHash('deckent.provider-spend-outcome.v1', outcome) }
      : { state: 'held', reason: state === 'held-overrun' ? 'overrun' : 'unknown',
        observedMinorUnits: state === 'held-overrun' ? 5 : null,
        evidenceDigest: historicalHash('deckent.provider-spend-outcome.v1', outcome) };
    const nextReservation = { ...reservation, disposition };
    const account = JSON.parse(accountRow.record) as Record<string, unknown>;
    const nextAccount = { ...account, reservedMinorUnits: state.startsWith('held') ? 4 : 0,
      settledMinorUnits: state === 'settled-local' ? 3 : 0, frozen: state === 'held-overrun' };
    db.prepare('UPDATE model_invocations SET state=?,record=? WHERE scope_id=? AND invocation_id=?')
      .run(outcome.state, JSON.stringify(nextReceipt), invocationRow.scope_id, invocationRow.invocation_id);
    db.prepare('UPDATE model_invocation_spend_reservations SET record=?,digest=? WHERE scope_id=? AND invocation_id=?')
      .run(JSON.stringify(nextReservation), historicalHash('deckent.provider-spend-reservation.v1', nextReservation),
        invocationRow.scope_id, invocationRow.invocation_id);
    db.prepare('UPDATE provider_spend_accounts SET record=?,digest=? WHERE scope_id=?')
      .run(JSON.stringify(nextAccount), historicalHash('deckent.provider-spend-checkpoint.v1',
        { revision: accountRow.revision, reservationCount: accountRow.reservation_count, account: nextAccount }), invocationRow.scope_id);
  } finally { db.close(); }
}
async function seedLedger20(file: string) {
  await seedLedger18(file);
  const activationDb = new DatabaseSync(file, { readOnly: true });
  let activation: unknown;
  try { activation = JSON.parse(String((activationDb.prepare('SELECT record FROM model_activations').get() as { record: string }).record)); }
  finally { activationDb.close(); }
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'fixture', version: 1, definition: {} }, allocation: { id: 'allocation-spend', maxCalls: 2, maxInFlight: 1 },
    limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  const command = { schemaVersion: 1 as const, commandId: 'spend-command', scopeId: 'scope', reference, catalogRevision: 'catalog',
    expectedBinding: binding, nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: 'spend' }] } };
  const requestDigest = modelInvocationRequestDigest(command), profileDigest = modelInvocationProfileDigest(profile);
  const store = await openSqliteModelInvocationStore(file, options, 'allow');
  await store.claim({ command, requestDigest, actor, authorization: { revision: 'policy', ruleId: 'invoke' }, definition, activation,
    profile, profileDigest, invocationId: 'spend-invocation', claimedAtMs: 3,
    spending: { budget: { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 10 },
      quote: { schemaVersion: 1, scopeId: 'scope', requestDigest, profileDigest,
        pricing: { id: 'price', version: 1, digest: '291f395a66cb728f57612b09b06f9512815b982e9a5d65e3fafec28256ff0aa9', definition: { schemaVersion: 1, kind: 'synthetic-price' } },
        meter: { id: 'meter', version: 1, evidenceDigest: '446658cc1c39184b672f423a7f970bffab0e8f38e851c5b5dacd3f38eb85051f', evidence: { schemaVersion: 1, kind: 'synthetic-meter' } },
        currency: 'USD', maxChargeMinorUnits: 4 } } });
  store.close();
  const db = new DatabaseSync(file);
  try {
    const accountRow = db.prepare('SELECT revision,reservation_count,record FROM provider_spend_accounts').get() as { revision: number; reservation_count: number; record: string };
    const currentAccount = JSON.parse(accountRow.record) as Record<string, unknown>;
    const { settledExactMinorUnits: _exact, ...withoutExact } = currentAccount; void _exact;
    const account = { ...withoutExact, schemaVersion: 1 };
    const accountDigest = historicalHash('deckent.provider-spend-checkpoint.v1',
      { revision: accountRow.revision, reservationCount: accountRow.reservation_count, account });
    db.prepare('UPDATE provider_spend_accounts SET record=?,digest=?').run(JSON.stringify(account), accountDigest);
    const reservationRow = db.prepare('SELECT scope_id,invocation_id,record FROM model_invocation_spend_reservations').get() as { scope_id: string; invocation_id: string; record: string };
    const currentReservation = JSON.parse(reservationRow.record) as Record<string, unknown>;
    const { measurement: _measurement, ...withoutMeasurement } = currentReservation; void _measurement;
    const reservation = { ...withoutMeasurement, schemaVersion: 1 };
    db.prepare('UPDATE model_invocation_spend_reservations SET record=?,digest=? WHERE scope_id=? AND invocation_id=?')
      .run(JSON.stringify(reservation), historicalHash('deckent.provider-spend-reservation.v1', reservation), reservationRow.scope_id, reservationRow.invocation_id);
    db.exec('DROP TABLE provider_spend_audits; DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=20');
  } finally { db.close(); }
}
async function seedLedger19(file: string) {
  await seedLedger18(file);
  const store = await openSqliteModelInvocationStore(file, options, 'allow'); store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec(`DROP TABLE model_invocation_spend_reservations;
      DROP TABLE provider_spend_accounts;
      DROP TABLE provider_spend_audits;
      DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=19;`);
  } finally { db.close(); }
}
function inventory(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('provider_spend_accounts','model_invocation_spend_reservations') ORDER BY name").all() as Array<{ name: string }>;
    return { version: db.prepare('PRAGMA user_version').get()?.user_version,
      invocations: db.prepare('SELECT scope_id,command_id,invocation_id,allocation_id,state,record FROM model_invocations').all(),
      controls: db.prepare('SELECT scope_id,invocation_id,send_state,record FROM model_invocation_controls').all(),
      accounts: tables.some(table => table.name === 'provider_spend_accounts')
        ? db.prepare('SELECT scope_id,revision,reservation_count,digest,record FROM provider_spend_accounts').all() : [],
      reservations: tables.some(table => table.name === 'model_invocation_spend_reservations')
        ? db.prepare('SELECT scope_id,invocation_id,digest,record FROM model_invocation_spend_reservations').all() : [],
      tables,
    };
  } finally { db.close(); }
}

it('migrates a genuine ledger18 through allocation19 and spend21 without fabricating monetary records', async () => {
  const file = await path(); await seedLedger18(file); const before = inventory(file);
  expect(before.version).toBe(18); expect(before.tables).toEqual([]);
  const store = await openSqliteModelInvocationStore(file, options, 'allow'); store.close();
  const after = inventory(file);
  expect(MODEL_ALLOCATION_LEDGER_VERSION).toBe(19); expect(PROVIDER_SPEND_LEDGER_VERSION).toBe(21);
  expect(after.version).toBe(CURRENT_LEDGER_VERSION); expect(after.invocations).toEqual(before.invocations); expect(after.controls).toEqual(before.controls);
  expect(after.tables).toEqual([{ name: 'model_invocation_spend_reservations' }, { name: 'provider_spend_accounts' }]);
  expect(after.accounts).toEqual([]); expect(after.reservations).toEqual([]);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA table_info(provider_spend_accounts)').all().map(row => (row as { name: string }).name))
      .toEqual(['scope_id', 'revision', 'reservation_count', 'digest', 'record']);
    expect(db.prepare('PRAGMA table_info(model_invocation_spend_reservations)').all().map(row => (row as { name: string }).name))
      .toEqual(['scope_id', 'invocation_id', 'digest', 'record']);
  }
  finally { db.close(); }
});

it('migrates a genuine allocation-only ledger19 to spend21 without changing its checkpoint or receipt', async () => {
  const file = await path(); await seedLedger19(file); const before = inventory(file);
  const checkpointBefore = new DatabaseSync(file, { readOnly: true });
  let checkpoints: unknown[];
  try { checkpoints = checkpointBefore.prepare('SELECT * FROM model_invocation_allocation_checkpoints').all(); }
  finally { checkpointBefore.close(); }
  expect(before.version).toBe(19); expect(before.tables).toEqual([]);
  const store = await openSqliteModelInvocationStore(file, options, 'allow'); store.close();
  const after = inventory(file);
  expect(after.version).toBe(CURRENT_LEDGER_VERSION); expect(after.invocations).toEqual(before.invocations); expect(after.controls).toEqual(before.controls);
  expect(after.accounts).toEqual([]); expect(after.reservations).toEqual([]);
  const db = new DatabaseSync(file, { readOnly: true });
  try { expect(db.prepare('SELECT * FROM model_invocation_allocation_checkpoints').all()).toEqual(checkpoints); }
  finally { db.close(); }
});

it('rolls spend20 DDL and its version back to allocation-only19 with an outer transaction failure', async () => {
  const file = await path(); await seedLedger19(file); const db = new DatabaseSync(file);
  try {
    expect(() => {
      db.exec('BEGIN IMMEDIATE');
      try {
        migrateLedger(db, 'allow');
        db.exec('CREATE TABLE provider_spend_accounts(duplicate TEXT)');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK'); throw error;
      }
    }).toThrow();
  } finally { db.close(); }
  const after = inventory(file);
  expect(after.version).toBe(19); expect(after.tables).toEqual([]);
});

it('rejects the impossible unlanded combined ledger19 instead of reinterpreting it as allocation-only', async () => {
  const file = await path(); await seedLedger19(file); const db = new DatabaseSync(file);
  try { db.exec('CREATE TABLE provider_spend_accounts(scope_id TEXT PRIMARY KEY NOT NULL);'); }
  finally { db.close(); }
  await expect(openSqliteModelInvocationStore(file, options, 'allow'))
    .rejects.toMatchObject({ code: 'LEDGER_MIGRATION_EVIDENCE_REQUIRED' });
  const after = new DatabaseSync(file, { readOnly: true });
  try {
    expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(19);
    expect(after.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE '%spend%' ORDER BY name").all())
      .toEqual([{ name: 'provider_spend_accounts' }]);
  } finally { after.close(); }
});

it('opens a ledger18 invocation reader without migrating or changing bytes', async () => {
  const file = await path(); await seedLedger18(file); const before = await readFile(file);
  const reader = await openSqliteModelInvocationReader(file, { busyTimeoutMs: 20 }); reader.close();
  expect(await readFile(file)).toEqual(before);
  const after = inventory(file); expect(after.version).toBe(18); expect(after.tables).toEqual([]);
});

it('validates and translates a genuine ledger20 reservation without inferring a measurement', async () => {
  const file = await path(); await seedLedger20(file);
  const before = inventory(file); expect(before.version).toBe(20);
  const store = await openSqliteModelInvocationStore(file, options, 'allow'); store.close();
  const after = inventory(file); expect(after.version).toBe(CURRENT_LEDGER_VERSION);
  expect(JSON.parse(String(after.accounts[0]!.record))).toMatchObject({ schemaVersion: 2, settledMinorUnits: 0,
    settledExactMinorUnits: '0', reservedMinorUnits: 4 });
  expect(JSON.parse(String(after.reservations[0]!.record))).toMatchObject({ schemaVersion: 2, measurement: null,
    disposition: { state: 'reserved' } });
});

it.each(['settled-local', 'released-not-sent', 'held-unknown', 'held-overrun'] as const)(
  'validates and translates genuine ledger20 %s history without fabricating provider measurement', async state => {
    const file = await path(); await seedLedger20(file); setLedger20TerminalState(file, state);
    const store = await openSqliteModelInvocationStore(file, options, 'allow'); store.close();
    const after = inventory(file), account = JSON.parse(String(after.accounts[0]!.record));
    const reservation = JSON.parse(String(after.reservations[0]!.record));
    const expected = {
      'settled-local': { account: { reservedMinorUnits: 0, settledMinorUnits: 3, settledExactMinorUnits: '3', frozen: false },
        disposition: { state: 'settled-local', amountMinorUnits: 3 } },
      'released-not-sent': { account: { reservedMinorUnits: 0, settledMinorUnits: 0, settledExactMinorUnits: '0', frozen: false },
        disposition: { state: 'released-not-sent' } },
      'held-unknown': { account: { reservedMinorUnits: 4, settledMinorUnits: 0, settledExactMinorUnits: '0', frozen: false },
        disposition: { state: 'held', reason: 'unknown', observedMinorUnits: null } },
      'held-overrun': { account: { reservedMinorUnits: 4, settledMinorUnits: 0, settledExactMinorUnits: '0', frozen: true },
        disposition: { state: 'held', reason: 'overrun', observedMinorUnits: 5 } },
    }[state];
    expect(after.version).toBe(CURRENT_LEDGER_VERSION);
    expect(account).toMatchObject({ schemaVersion: 2, ...expected.account });
    expect(reservation).toMatchObject({ schemaVersion: 2, measurement: null, disposition: expected.disposition });
  });

it('rolls back an earlier translated account when a later account update fails', async () => {
  const file = await path(); await seedLedger20(file); const before = inventory(file); const db = new DatabaseSync(file);
  try {
    const budget = { schemaVersion: 1, scopeId: 'scope-z', budgetId: 'budget-z', revision: 1, currency: 'USD', limitMinorUnits: 10 };
    const account = { schemaVersion: 1, budget, reservedMinorUnits: 0, settledMinorUnits: 0, frozen: false };
    const revision = 1, reservationCount = 0;
    db.prepare('INSERT INTO provider_spend_accounts(scope_id,revision,reservation_count,digest,record) VALUES(?,?,?,?,?)')
      .run(budget.scopeId, revision, reservationCount,
        historicalHash('deckent.provider-spend-checkpoint.v1', { revision, reservationCount, account }), JSON.stringify(account));
    db.exec(`CREATE TRIGGER reject_second_account BEFORE UPDATE ON provider_spend_accounts
      WHEN OLD.scope_id='scope-z' BEGIN SELECT RAISE(ABORT,'reject second account'); END;`);
  } finally { db.close(); }
  await expect(openSqliteModelInvocationStore(file, options, 'allow'))
    .rejects.toMatchObject({ code: 'LEDGER_MIGRATION_EVIDENCE_REQUIRED' });
  const after = inventory(file);
  const originalAccount = after.accounts.find(row => row.scope_id === 'scope');
  const secondAccount = after.accounts.find(row => row.scope_id === 'scope-z');
  expect(after.version).toBe(20);
  expect(originalAccount).toEqual(before.accounts[0]);
  expect(after.reservations).toEqual(before.reservations);
  expect(JSON.parse(String(secondAccount!.record))).toMatchObject({ schemaVersion: 1, budget: { scopeId: 'scope-z' } });
  const retry = new DatabaseSync(file); retry.exec('DROP TRIGGER reject_second_account'); retry.close();
  const migrated = await openSqliteModelInvocationStore(file, options, 'allow'); migrated.close();
  const completed = inventory(file); expect(completed.version).toBe(CURRENT_LEDGER_VERSION);
  expect(completed.accounts.map(row => JSON.parse(String(row.record)).schemaVersion)).toEqual([2, 2]);
});

it('rolls ledger21 migration back when a ledger20 reservation checksum is invalid', async () => {
  const file = await path(); await seedLedger20(file); const db = new DatabaseSync(file);
  try { db.prepare('UPDATE model_invocation_spend_reservations SET digest=?').run('0'.repeat(64)); } finally { db.close(); }
  await expect(openSqliteModelInvocationStore(file, options, 'allow'))
    .rejects.toMatchObject({ code: 'LEDGER_MIGRATION_EVIDENCE_REQUIRED' });
  const after = inventory(file); expect(after.version).toBe(20);
  expect(JSON.parse(String(after.accounts[0]!.record))).toMatchObject({ schemaVersion: 1 });
  expect(JSON.parse(String(after.reservations[0]!.record))).toMatchObject({ schemaVersion: 1 });
});

it('rejects ledger20 through the runtime integrity reader without migrating bytes', async () => {
  const file = await path(); await seedLedger20(file); const before = await readFile(file);
  const { openSqliteProviderSpendIntegrityReader } = await import('#adapters/index.js');
  await expect(openSqliteProviderSpendIntegrityReader(file, { busyTimeoutMs: 20 }))
    .rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  expect(await readFile(file)).toEqual(before);
});

it('does not hide a genuine ledger20 monetary reservation from invocation inspection', async () => {
  const file = await path(); await seedLedger20(file); const before = await readFile(file);
  const reader = await openSqliteModelInvocationReader(file, { busyTimeoutMs: 20 });
  try {
    await expect(reader.loadInvocation('scope', 'spend-invocation')).resolves.not.toBeNull();
    await expect(reader.loadInspection('scope', 'spend-invocation'))
      .rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  } finally { reader.close(); }
  expect(await readFile(file)).toEqual(before);
});

it('creates current spend metadata empty on a fresh writer', async () => {
  const file = await path(); const store = await openSqliteModelInvocationStore(file, options, 'allow'); store.close();
  const state = inventory(file);
  expect(state.version).toBe(CURRENT_LEDGER_VERSION);
  expect(state.tables).toEqual([{ name: 'model_invocation_spend_reservations' }, { name: 'provider_spend_accounts' }]);
  expect(state.accounts).toEqual([]); expect(state.reservations).toEqual([]);
});
