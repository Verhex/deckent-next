import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteModelActivationStore, openSqliteModelInvocationReader,
  openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';

const options = { busyTimeoutMs: 20, journalMode: 'delete' as const, durability: 'full' as const };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };

async function workspace(work: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-migration-'));
  try { await work(join(root, 'ledger.db')); } finally { await rm(root, { recursive: true, force: true }); }
}
async function seedV13(path: string) {
  const attempts = await openSqliteAttemptStore(path, options);
  try { await admitRunAttempts(attempts, [{ scopeId: 'scope', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 }]); }
  finally { attempts.close(); }
  const activation = await openSqliteModelActivationStore(path, options, 'forbid');
  try {
    await activation.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
      reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding },
    actor: { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' },
    authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  } finally { activation.close(); }
  const db = new DatabaseSync(path);
  try {
    db.exec(`DROP INDEX model_invocations_allocation_state;
      DROP TABLE model_invocations; DROP TABLE model_invocation_allocations; PRAGMA user_version=13`);
  } finally { db.close(); }
}
async function seedV14Invocations(path: string, corrupt?: 'receipt' | 'numeric' | 'ceiling') {
  await seedV13(path);
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'loopback-http', version: 1, definition: { origin: 'http://127.0.0.1:1' } },
    allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 2 },
    limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  const db = new DatabaseSync(path, { readOnly: true });
  const activation = JSON.parse(String(db.prepare('SELECT record FROM model_activations').get()?.record)); db.close();
  const makeAdmission = (commandId: string, invocationId: string) => {
    const command = { schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
      nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: commandId }] } };
    return { command, requestDigest: modelInvocationRequestDigest(command), actor: { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' as const },
      authorization: { revision: 'policy', ruleId: 'invoke' }, definition, activation, profile,
      profileDigest: modelInvocationProfileDigest(profile), invocationId, claimedAtMs: 10 };
  };
  const store = await openSqliteModelInvocationStore(path, options, 'allow');
  const responded = await store.claim(makeAdmission('responded-command', 'responded-invocation'));
  await store.recordResponse(responded.receipt.claim, { schemaVersion: 1, native: { id: 'response' }, usage: null }, 20);
  const unknown = await store.claim(makeAdmission('unknown-command', 'unknown-invocation'));
  await store.recordUnknown(unknown.receipt.claim, 'transport-error', 21); store.close();
  const downgrade = new DatabaseSync(path);
  try {
    for (const row of downgrade.prepare('SELECT invocation_id,record FROM model_invocations').all()) {
      const receipt = JSON.parse(String(row.record)) as Record<string, unknown>;
      const outcome = receipt.outcome as Record<string, unknown>;
      const oldOutcome = { ...outcome, schemaVersion: 1 }; delete oldOutcome.evidence;
      const old = { ...receipt, schemaVersion: 1, outcome: oldOutcome };
      if (corrupt === 'receipt' && row.invocation_id === 'unknown-invocation') old.unexpected = true;
      downgrade.prepare('UPDATE model_invocations SET record=? WHERE invocation_id=?').run(JSON.stringify(old), String(row.invocation_id));
    }
    downgrade.exec(`DROP INDEX model_invocations_allocation_state;
      ALTER TABLE model_invocations RENAME TO model_invocations_current;
      CREATE TABLE model_invocations(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,invocation_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('claimed','responded','unknown')),record TEXT NOT NULL,
        PRIMARY KEY(scope_id,invocation_id),UNIQUE(scope_id,command_id));
      INSERT INTO model_invocations SELECT * FROM model_invocations_current; DROP TABLE model_invocations_current;
      CREATE INDEX model_invocations_allocation_state ON model_invocations(scope_id,allocation_id,state);
      PRAGMA user_version=14;`);
    if (corrupt === 'numeric' || corrupt === 'ceiling') {
      const row = downgrade.prepare('SELECT record FROM model_invocation_allocations').get();
      const record = JSON.parse(String(row?.record)) as Record<string, unknown>;
      const maxCalls = corrupt === 'numeric' ? -1 : 3;
      downgrade.prepare('UPDATE model_invocation_allocations SET max_calls=?,record=?')
        .run(maxCalls, JSON.stringify({ ...record, maxCalls }));
    }
  } finally { downgrade.close(); }
}
function evidence(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: db.prepare('PRAGMA user_version').get()?.user_version,
      activation: db.prepare('SELECT revision,record FROM model_activations').all(),
      activationReceipts: db.prepare('SELECT command_id,record FROM model_activation_receipts').all(),
      attempts: db.prepare('SELECT scope_id,attempt_id,snapshot FROM attempts').all(),
      runReceipts: db.prepare('SELECT command_id,command,snapshot FROM run_receipts').all(),
    };
  } finally { db.close(); }
}

it('migrates genuine v13 activation and execution evidence to v15 without changing existing payloads', async () => workspace(async path => {
  await seedV13(path);
  const before = evidence(path);
  expect(before.version).toBe(13);
  const store = await openSqliteModelInvocationStore(path, options, 'allow');
  store.close();
  const after = evidence(path);
  expect(after).toEqual({ ...before, version: 15 });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('model_invocation_allocations','model_invocations') ORDER BY name").all())
      .toEqual([{ name: 'model_invocation_allocations' }, { name: 'model_invocations' }]);
  } finally { db.close(); }
}));

it('forbids v13 read-only mutation and rolls back a partial v14 collision without touching activation or execution evidence', async () => workspace(async path => {
  await seedV13(path);
  const before = evidence(path);
  const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(path));
  await expect(openSqliteModelInvocationReader(path, { busyTimeoutMs: 20 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  expect(evidence(path)).toEqual(before);
  await expect(import('node:fs/promises').then(({ readFile }) => readFile(path))).resolves.toEqual(bytes);

  const db = new DatabaseSync(path);
  try { db.exec('CREATE TABLE model_invocations(marker TEXT)'); } finally { db.close(); }
  await expect(openSqliteModelInvocationStore(path, options, 'allow')).rejects.toThrow();
  const failed = evidence(path);
  expect(failed).toEqual(before);
  const inspect = new DatabaseSync(path, { readOnly: true });
  try {
    expect(inspect.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='model_invocations'").get()?.sql).toContain('marker TEXT');
    expect(inspect.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='model_invocation_allocations'").all()).toEqual([]);
  } finally { inspect.close(); }
}));

it('converts exact v14 receipts to v2 and rolls malformed history back without partial schema replacement', async () => {
  await workspace(async path => {
    await seedV14Invocations(path);
    const store = await openSqliteModelInvocationStore(path, options, 'allow'); store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(15);
      const receipts = db.prepare('SELECT state,record FROM model_invocations ORDER BY state').all()
        .map(row => JSON.parse(String(row.record)) as Record<string, unknown>);
      expect(receipts.map(receipt => receipt.schemaVersion)).toEqual([2, 2]);
      expect(receipts.find(receipt => (receipt.outcome as Record<string, unknown>).state === 'unknown')?.outcome)
        .toMatchObject({ schemaVersion: 2, state: 'unknown', evidence: null });
      expect(String(db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='model_invocations'").get()?.sql))
        .toContain("'rejected'");
    } finally { db.close(); }
  });
  for (const damage of ['receipt', 'numeric', 'ceiling'] as const) await workspace(async path => {
    await seedV14Invocations(path, damage);
    const before = new DatabaseSync(path, { readOnly: true });
    const rows = before.prepare('SELECT * FROM model_invocations ORDER BY invocation_id').all();
    const allocations = before.prepare('SELECT * FROM model_invocation_allocations ORDER BY allocation_id').all(); before.close();
    await expect(openSqliteModelInvocationStore(path, options, 'allow')).rejects.toThrow('LEDGER_MIGRATION_EVIDENCE_REQUIRED');
    const after = new DatabaseSync(path, { readOnly: true });
    try {
      expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(14);
      expect(after.prepare('SELECT * FROM model_invocations ORDER BY invocation_id').all()).toEqual(rows);
      expect(after.prepare('SELECT * FROM model_invocation_allocations ORDER BY allocation_id').all()).toEqual(allocations);
      expect(after.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='model_invocations_v15'").all()).toEqual([]);
    } finally { after.close(); }
  });
});
