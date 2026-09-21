import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore } from '#adapters/index.js';
import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';

const options = { busyTimeoutMs: 20, journalMode: 'delete' as const, durability: 'full' as const };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;

async function workspace(work: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-purge-migration-'));
  try { await work(join(root, 'ledger.db')); } finally { await rm(root, { recursive: true, force: true }); }
}

/** Materialize v16's table, rather than only changing user_version on a v17 database. */
async function seedV16(path: string) {
  const activations = await openSqliteModelActivationStore(path, options);
  const activation = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  activations.close();
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'loopback-http', version: 1, definition: { origin: 'http://127.0.0.1:1' } },
    allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 2 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  const admission = (commandId: string, invocationId: string) => {
    const command = { schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
      nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: commandId }] } };
    return { command, requestDigest: modelInvocationRequestDigest(command), actor, authorization: { revision: 'policy', ruleId: 'invoke' },
      definition, activation: activation.receipt.record, profile, profileDigest: modelInvocationProfileDigest(profile), invocationId, claimedAtMs: 10 };
  };
  const store = await openSqliteModelInvocationStore(path, options, 'allow');
  const responded = await store.claim(admission('responded-command', 'responded-invocation'));
  await store.permitSend(responded.record.receipt.claim, 'migration-fixture', 11);
  await store.recordResponse(responded.record.receipt.claim, { schemaVersion: 1, native: { id: 'sensitive-response' }, usage: null }, 20);
  const unknown = await store.claim(admission('unknown-command', 'unknown-invocation'));
  await store.permitSend(unknown.record.receipt.claim, 'migration-fixture', 11);
  await store.recordUnknown(unknown.record.receipt.claim, 'transport-error', 21);
  store.close();

  const db = new DatabaseSync(path);
  try {
    for (const row of db.prepare('SELECT invocation_id,record FROM model_invocations').all() as Array<{ invocation_id: string; record: string }>) {
      const receipt = JSON.parse(row.record); receipt.schemaVersion = 3;
      if (receipt.outcome) receipt.outcome.schemaVersion = 3;
      db.prepare('UPDATE model_invocations SET record=? WHERE invocation_id=?').run(JSON.stringify(receipt), row.invocation_id);
    }
    db.exec(`DROP TABLE provider_spend_audits; DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts; DROP TABLE model_invocation_allocation_checkpoints; DROP INDEX model_invocations_allocation_identity;
      DROP TABLE model_invocation_cancellations; DROP TABLE model_invocation_controls;
      ALTER TABLE model_invocation_contents RENAME TO model_invocation_contents_v17;
      DROP TABLE model_invocation_content_purges;
      CREATE TABLE model_invocation_contents(scope_id TEXT NOT NULL,invocation_id TEXT NOT NULL,record TEXT NOT NULL,
        PRIMARY KEY(scope_id,invocation_id),FOREIGN KEY(scope_id,invocation_id) REFERENCES model_invocations(scope_id,invocation_id));
      INSERT INTO model_invocation_contents(scope_id,invocation_id,record)
        SELECT scope_id,invocation_id,record FROM model_invocation_contents_v17 WHERE record IS NOT NULL;
      DROP TABLE model_invocation_contents_v17; DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=16;`);
  } finally { db.close(); }
}

function inventory(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { version: db.prepare('PRAGMA user_version').get()?.user_version,
      invocations: db.prepare('SELECT * FROM model_invocations ORDER BY invocation_id').all(),
      contents: db.prepare('SELECT * FROM model_invocation_contents ORDER BY invocation_id').all(),
      tables: db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name LIKE 'model_invocation_content%' ORDER BY name").all() };
  } finally { db.close(); }
}

it('migrates a genuine ledger16 content inventory through the current ledger without changing retained records', async () => workspace(async path => {
  await seedV16(path);
  const before = inventory(path);
  expect(before.version).toBe(16);
  expect(before.contents).toHaveLength(1);
  expect(String(before.contents[0]?.record)).toContain('sensitive-response');
  const store = await openSqliteModelInvocationStore(path, options, 'allow'); store.close();
  const after = inventory(path);
  expect(after.version).toBe(CURRENT_LEDGER_VERSION);
  expect(after.invocations.map(row => ({ ...row, record: undefined }))).toEqual(before.invocations.map(row => ({ ...row, record: undefined })));
  for (const row of after.invocations) expect(JSON.parse(String(row.record))).toMatchObject({ schemaVersion: 4 });
  expect(after.contents.map(row => ({ scope_id: row.scope_id, invocation_id: row.invocation_id, record: row.record }))).toEqual(before.contents);
  expect(after.contents.map(row => row.purge_command_id)).toEqual([null]);
  expect(after.tables.map(table => table.name)).toEqual(['model_invocation_content_purges', 'model_invocation_contents']);
  expect(String(after.tables.find(table => table.name === 'model_invocation_contents')?.sql)).toContain('purge_command_id TEXT');
  expect(String(after.tables.find(table => table.name === 'model_invocation_contents')?.sql)).toContain('CHECK((record IS NOT NULL AND purge_command_id IS NULL)');
}));

it('rejects corrupt v16 content inventories and rolls the ledger back unchanged', async () => {
  for (const damage of ['missing', 'extra', 'identity'] as const) await workspace(async path => {
    await seedV16(path);
    const db = new DatabaseSync(path);
    try {
      if (damage === 'missing') db.prepare("DELETE FROM model_invocation_contents WHERE invocation_id='responded-invocation'").run();
      if (damage === 'extra') {
        const content = db.prepare("SELECT record FROM model_invocation_contents WHERE invocation_id='responded-invocation'").get() as { record: string };
        db.prepare('INSERT INTO model_invocation_contents(scope_id,invocation_id,record) VALUES(?,?,?)').run('scope', 'unknown-invocation', content.record);
      }
      if (damage === 'identity') {
        const row = db.prepare("SELECT record FROM model_invocations WHERE invocation_id='responded-invocation'").get() as { record: string };
        const receipt = JSON.parse(row.record); receipt.claim.invocationId = 'different-invocation';
        db.prepare("UPDATE model_invocations SET record=? WHERE invocation_id='responded-invocation'").run(JSON.stringify(receipt));
      }
    } finally { db.close(); }
    const before = inventory(path);
    await expect(openSqliteModelInvocationStore(path, options, 'allow')).rejects.toThrow('LEDGER_MIGRATION_EVIDENCE_REQUIRED');
    expect(inventory(path)).toEqual(before);
  });
});
