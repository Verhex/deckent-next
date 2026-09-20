import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { createModelAllocationCheckpoint, modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';

const roots: string[] = [];
const options = { busyTimeoutMs: 20, journalMode: 'delete' as const, durability: 'full' as const };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' as const };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function file() { const root = await mkdtemp(join(tmpdir(), 'deckent-allocation-migration-')); roots.push(root); return join(root, 'ledger.db'); }

async function seed18(path: string) {
  const activations = await openSqliteModelActivationStore(path, options);
  const activation = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  activations.close();
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'openai-chat-http', version: 3, definition: { endpoint: 'http://127.0.0.1:1/', maxOutputTokens: 1,
      authentication: { type: 'none' } } }, allocation: { id: 'allocation', maxCalls: 3, maxInFlight: 2 },
    limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'catalog',
    expectedBinding: binding, nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: 'prompt' }] } };
  const store = await openSqliteModelInvocationStore(path, options, 'allow');
  await store.claim({ command, requestDigest: modelInvocationRequestDigest(command), actor,
    authorization: { revision: 'policy', ruleId: 'invoke' }, definition, activation: activation.receipt.record, profile,
    profileDigest: modelInvocationProfileDigest(profile), invocationId: 'invocation', claimedAtMs: 2 });
  store.close();
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec(`DROP TABLE model_invocation_allocation_checkpoints;
      DROP INDEX model_invocations_allocation_identity;
      PRAGMA user_version=18;`);
  } finally { db.close(); }
}
function snapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { version: db.prepare('PRAGMA user_version').get()?.user_version,
    allocations: db.prepare('SELECT * FROM model_invocation_allocations').all(),
    invocations: db.prepare('SELECT * FROM model_invocations').all(), controls: db.prepare('SELECT * FROM model_invocation_controls').all() }; }
  finally { db.close(); }
}

it('migrates a real ledger18 allocation inventory to revision-one checkpoints without changing receipts', async () => {
  const path = await file(); await seed18(path); const before = snapshot(path);
  const store = await openSqliteModelInvocationStore(path, options, 'allow'); store.close();
  const after = snapshot(path); expect(after).toEqual({ ...before, version: 19 });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const allocationRow = db.prepare('SELECT record FROM model_invocation_allocations').get() as { record: string };
    const checkpoint = createModelAllocationCheckpoint(JSON.parse(allocationRow.record), 1);
    expect(db.prepare('SELECT scope_id,allocation_id,revision,digest FROM model_invocation_allocation_checkpoints').get())
      .toEqual({ scope_id: 'scope', allocation_id: 'allocation', revision: 1, digest: checkpoint.digest });
    expect(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='model_invocations_allocation_identity'").get()?.sql))
      .toContain('invocation_id COLLATE BINARY');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
});

it('rejects corrupt or missing allocation evidence and orphan invocation identity with full rollback', async () => {
  for (const damage of ['column', 'record', 'missing', 'orphan'] as const) {
    const path = await file(); await seed18(path); const db = new DatabaseSync(path);
    try {
      if (damage === 'column') db.prepare('UPDATE model_invocation_allocations SET lifetime_calls=0').run();
      if (damage === 'record') db.prepare("UPDATE model_invocation_allocations SET record='{}'").run();
      if (damage === 'missing') { db.exec('PRAGMA foreign_keys=OFF'); db.prepare('DELETE FROM model_invocation_allocations').run(); }
      if (damage === 'orphan') { db.exec('PRAGMA foreign_keys=OFF'); db.prepare("UPDATE model_invocations SET allocation_id='missing'").run(); }
    } finally { db.close(); }
    await expect(openSqliteModelInvocationStore(path, options, 'allow')).rejects.toMatchObject({ code: 'LEDGER_MIGRATION_EVIDENCE_REQUIRED' });
    const after = new DatabaseSync(path, { readOnly: true });
    try {
      expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(18);
      expect(after.prepare("SELECT name FROM sqlite_schema WHERE name IN ('model_invocation_allocation_checkpoints')").all()).toEqual([]);
    } finally { after.close(); }
  }
});

it('opens a ledger18 reader without migration or byte changes', async () => {
  const path = await file(); await seed18(path); const before = await readFile(path);
  const reader = await openSqliteModelInvocationReader(path, { busyTimeoutMs: 20 }); reader.close();
  expect(await readFile(path)).toEqual(before); expect(snapshot(path).version).toBe(18);
});
