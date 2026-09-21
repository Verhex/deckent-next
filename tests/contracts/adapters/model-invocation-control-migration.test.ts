import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteModelInvocationStore } from '#adapters/index.js';
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
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-control-migration-'));
  try { await work(join(root, 'ledger.db')); } finally { await rm(root, { recursive: true, force: true }); }
}
async function seedV17(path: string) {
  const activations = await openSqliteModelActivationStore(path, options);
  const activation = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  activations.close();
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'loopback-http', version: 1, definition: { origin: 'http://127.0.0.1:1' } },
    allocation: { id: 'allocation', maxCalls: 3, maxInFlight: 3 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  const admission = (commandId: string, invocationId: string) => {
    const command = { schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
      nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: commandId }] } };
    return { command, requestDigest: modelInvocationRequestDigest(command), actor, authorization: { revision: 'policy', ruleId: 'invoke' },
      definition, activation: activation.receipt.record, profile, profileDigest: modelInvocationProfileDigest(profile), invocationId, claimedAtMs: 10 };
  };
  const store = await openSqliteModelInvocationStore(path, options, 'allow');
  const responded = await store.claim(admission('responded-command', 'responded-invocation'));
  await store.permitSend(responded.record.receipt.claim, 'migration-fixture', 11);
  await store.recordResponse(responded.record.receipt.claim, { schemaVersion: 1, native: { id: 'response' }, usage: null }, 20);
  const purged = await store.claim(admission('purged-command', 'purged-invocation'));
  await store.permitSend(purged.record.receipt.claim, 'migration-fixture', 11);
  const purgeRecord = await store.recordResponse(purged.record.receipt.claim, { schemaVersion: 1, native: { id: 'purged' }, usage: null }, 21);
  await store.purgeContent({ command: { schemaVersion: 1, commandId: 'purge-command', scopeId: 'scope', invocationId: 'purged-invocation',
    reference, expectedContentDigest: purgeRecord.content!.descriptor.digest }, actor,
  authorization: { revision: 'policy', ruleId: 'purge' }, purgedAtMs: 22 });
  const unknown = await store.claim(admission('unknown-command', 'unknown-invocation'));
  await store.permitSend(unknown.record.receipt.claim, 'migration-fixture', 11);
  await store.recordUnknown(unknown.record.receipt.claim, 'transport-error', 23);
  store.close();

  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec(`DROP TABLE provider_spend_audits; DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts; DROP TABLE model_invocation_allocation_checkpoints; DROP INDEX model_invocations_allocation_identity;
      DROP TABLE model_invocation_cancellations; DROP TABLE model_invocation_controls;`);
    for (const row of db.prepare('SELECT invocation_id,record FROM model_invocations').all() as Array<{ invocation_id: string; record: string }>) {
      const receipt = JSON.parse(row.record); receipt.schemaVersion = 3;
      if (receipt.outcome) receipt.outcome.schemaVersion = 3;
      db.prepare('UPDATE model_invocations SET record=? WHERE invocation_id=?').run(JSON.stringify(receipt), row.invocation_id);
    }
    db.exec(`CREATE TABLE model_invocations_v17(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,invocation_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('claimed','responded','unknown','rejected')),record TEXT NOT NULL,
      PRIMARY KEY(scope_id,invocation_id),UNIQUE(scope_id,command_id));
      INSERT INTO model_invocations_v17 SELECT * FROM model_invocations;
      DROP INDEX model_invocations_allocation_state; DROP TABLE model_invocations;
      ALTER TABLE model_invocations_v17 RENAME TO model_invocations;
      CREATE INDEX model_invocations_allocation_state ON model_invocations(scope_id,allocation_id,state);
      DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=17;`);
  } finally { db.close(); }
}
function inventory(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { version: db.prepare('PRAGMA user_version').get()?.user_version,
    invocations: db.prepare('SELECT * FROM model_invocations ORDER BY invocation_id').all(),
    allocations: db.prepare('SELECT * FROM model_invocation_allocations').all(),
    contents: db.prepare('SELECT * FROM model_invocation_contents ORDER BY invocation_id').all(),
    purges: db.prepare('SELECT * FROM model_invocation_content_purges').all() }; }
  finally { db.close(); }
}

it('migrates genuine ledger17 receipts, content, purge evidence, and counters to honest unobserved controls', async () => workspace(async path => {
  await seedV17(path); const before = inventory(path);
  await expect(openSqliteModelInvocationReader(path, { busyTimeoutMs: 20 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  const store = await openSqliteModelInvocationStore(path, options, 'allow'); store.close();
  const after = inventory(path);
  expect(after.version).toBe(CURRENT_LEDGER_VERSION); expect(after.allocations).toEqual(before.allocations);
  expect(after.contents).toEqual(before.contents); expect(after.purges).toEqual(before.purges);
  expect(after.invocations.map(row => ({ ...row, record: undefined }))).toEqual(before.invocations.map(row => ({ ...row, record: undefined })));
  const db = new DatabaseSync(path, { readOnly: true });
  const controls = db.prepare('SELECT send_state,record FROM model_invocation_controls ORDER BY invocation_id').all() as Array<{ send_state: string; record: string }>;
  expect(controls).toHaveLength(3);
  for (const row of controls) expect({ sendState: row.send_state, record: JSON.parse(row.record) }).toMatchObject({ sendState: 'unobserved',
    record: { schemaVersion: 1, send: { state: 'unobserved' }, cancellation: null } });
  expect(db.prepare('SELECT * FROM model_invocation_cancellations').all()).toEqual([]);
  expect(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='model_invocations'").get()?.sql)).toContain("'not-sent'");
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]); db.close();
}));

it('rejects corrupt ledger17 identity, orphan evidence, purge references, and allocation evidence with full rollback', async () => {
  for (const damage of ['identity', 'content', 'orphan-content', 'purge', 'purge-identity', 'count', 'allocation-shape'] as const) await workspace(async path => {
    await seedV17(path); const db = new DatabaseSync(path);
    try {
      if (damage === 'identity') {
        const row = db.prepare("SELECT record FROM model_invocations WHERE invocation_id='unknown-invocation'").get() as { record: string };
        const receipt = JSON.parse(row.record); receipt.claim.invocationId = 'other';
        db.prepare("UPDATE model_invocations SET record=? WHERE invocation_id='unknown-invocation'").run(JSON.stringify(receipt));
      }
      if (damage === 'content') db.prepare("UPDATE model_invocation_contents SET record='{}' WHERE invocation_id='responded-invocation'").run();
      if (damage === 'purge') db.prepare("UPDATE model_invocation_content_purges SET record='{}'").run();
      if (damage === 'orphan-content') {
        db.exec('PRAGMA foreign_keys=OFF');
        db.prepare('INSERT INTO model_invocation_contents(scope_id,invocation_id,record,purge_command_id) VALUES(?,?,?,NULL)')
          .run('scope', 'orphan-invocation', JSON.stringify({ schemaVersion: 1 }));
      }
      if (damage === 'purge-identity') {
        db.exec('PRAGMA foreign_keys=OFF');
        db.prepare("UPDATE model_invocation_content_purges SET invocation_id='unknown-invocation'").run();
      }
      if (damage === 'count') db.prepare('UPDATE model_invocation_allocations SET in_flight=0').run();
      if (damage === 'allocation-shape') {
        const row = db.prepare('SELECT record FROM model_invocation_allocations').get() as { record: string };
        db.prepare('UPDATE model_invocation_allocations SET max_calls=0,record=?').run(JSON.stringify({ ...JSON.parse(row.record), maxCalls: 0, extra: true }));
      }
    } finally { db.close(); }
    const before = inventory(path);
    await expect(openSqliteModelInvocationStore(path, options, 'allow')).rejects.toThrow('LEDGER_MIGRATION_EVIDENCE_REQUIRED');
    expect(inventory(path)).toEqual(before);
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare("SELECT name FROM sqlite_schema WHERE name IN ('model_invocation_controls','model_invocation_cancellations')").all()).toEqual([]);
    check.close();
  });
});
