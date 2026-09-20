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
    profileDigest: modelInvocationProfileDigest(profile), invocationId: 'invocation', claimedAtMs: 2 });
  store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec(`DROP TABLE model_invocation_allocation_checkpoints; DROP INDEX model_invocations_allocation_identity;
      DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts; PRAGMA user_version=18;`);
  } finally { db.close(); }
}
async function seedLedger19(file: string) {
  await seedLedger18(file);
  const store = await openSqliteModelInvocationStore(file, options, 'allow'); store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec(`DROP TABLE model_invocation_spend_reservations;
      DROP TABLE provider_spend_accounts;
      PRAGMA user_version=19;`);
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

it('migrates a genuine ledger18 through allocation19 and spend20 without fabricating monetary records', async () => {
  const file = await path(); await seedLedger18(file); const before = inventory(file);
  expect(before.version).toBe(18); expect(before.tables).toEqual([]);
  const store = await openSqliteModelInvocationStore(file, options, 'allow'); store.close();
  const after = inventory(file);
  expect(MODEL_ALLOCATION_LEDGER_VERSION).toBe(19); expect(PROVIDER_SPEND_LEDGER_VERSION).toBe(20);
  expect(after.version).toBe(20); expect(after.invocations).toEqual(before.invocations); expect(after.controls).toEqual(before.controls);
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

it('migrates a genuine allocation-only ledger19 to spend20 without changing its checkpoint or receipt', async () => {
  const file = await path(); await seedLedger19(file); const before = inventory(file);
  const checkpointBefore = new DatabaseSync(file, { readOnly: true });
  let checkpoints: unknown[];
  try { checkpoints = checkpointBefore.prepare('SELECT * FROM model_invocation_allocation_checkpoints').all(); }
  finally { checkpointBefore.close(); }
  expect(before.version).toBe(19); expect(before.tables).toEqual([]);
  const store = await openSqliteModelInvocationStore(file, options, 'allow'); store.close();
  const after = inventory(file);
  expect(after.version).toBe(20); expect(after.invocations).toEqual(before.invocations); expect(after.controls).toEqual(before.controls);
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

it('creates ledger20 spend metadata empty on a fresh writer', async () => {
  const file = await path(); const store = await openSqliteModelInvocationStore(file, options, 'allow'); store.close();
  const state = inventory(file);
  expect(CURRENT_LEDGER_VERSION).toBe(20); expect(state.version).toBe(20);
  expect(state.tables).toEqual([{ name: 'model_invocation_spend_reservations' }, { name: 'provider_spend_accounts' }]);
  expect(state.accounts).toEqual([]); expect(state.reservations).toEqual([]);
});
