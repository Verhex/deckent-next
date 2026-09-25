import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteModelActivationStore, openSqliteModelInvocationReader,
  openSqliteModelInvocationStore } from '#adapters/index.js';
import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { createModelInvocationResponseEvidence, modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';
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
  try { await activation.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding },
  actor: { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' },
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition }); }
  finally { activation.close(); }
  const db = new DatabaseSync(path);
  try { db.exec(`DROP TABLE provider_spend_audits; DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts; DROP TABLE model_invocation_allocation_checkpoints; DROP INDEX model_invocations_allocation_identity;
    DROP TABLE model_invocation_cancellations; DROP TABLE model_invocation_controls;
    DROP INDEX model_invocations_allocation_state; DROP TABLE model_invocation_contents; DROP TABLE model_invocation_content_purges;
    DROP TABLE model_invocations; DROP TABLE model_invocation_allocations; DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS agent_turn_tool_calls; DROP TABLE IF EXISTS agent_turns; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=13`); }
  finally { db.close(); }
}
function profile() { return { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference,
  bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
  adapter: { id: 'loopback-http', version: 1, definition: { origin: 'http://127.0.0.1:1' } },
  allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 2 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } }; }
async function seedV14(path: string, corrupt?: 'receipt' | 'allocation') {
  await seedV13(path);
  const db = new DatabaseSync(path, { readOnly: true });
  const activation = JSON.parse(String(db.prepare('SELECT record FROM model_activations').get()?.record)); db.close();
  const makeAdmission = (commandId: string, invocationId: string) => {
    const command = { schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
      nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: commandId }] } };
    return { command, requestDigest: modelInvocationRequestDigest(command), actor: { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' as const },
      authorization: { revision: 'policy', ruleId: 'invoke' }, definition, activation, profile: profile(),
      profileDigest: modelInvocationProfileDigest(profile()), invocationId, claimedAtMs: 10 };
  };
  const store = await openSqliteModelInvocationStore(path, options, 'allow');
  const responded = await store.claim(makeAdmission('responded-command', 'responded-invocation'));
  await store.permitSend(responded.record.receipt.claim, 'migration-fixture', 11);
  await store.recordResponse(responded.record.receipt.claim, { schemaVersion: 1, native: { id: 'historical-response', text: 'historical sensitive body' }, usage: null }, 20);
  const unknown = await store.claim(makeAdmission('unknown-command', 'unknown-invocation'));
  await store.permitSend(unknown.record.receipt.claim, 'migration-fixture', 11);
  await store.recordUnknown(unknown.record.receipt.claim, 'transport-error', 21);
  store.close();

  // Construct the actual v14 wire record: response payload was embedded in receipt1; do not merely lower PRAGMA.
  const downgrade = new DatabaseSync(path);
  try {
    const rows = downgrade.prepare(`SELECT i.invocation_id,i.record,c.record AS content_record FROM model_invocations i
      LEFT JOIN model_invocation_contents c ON c.scope_id=i.scope_id AND c.invocation_id=i.invocation_id`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const receipt = JSON.parse(String(row.record)) as Record<string, unknown>, current = receipt.outcome as Record<string, unknown>;
      const oldOutcome = current.state === 'responded'
        ? { schemaVersion: 1, state: 'responded', response: (JSON.parse(String(row.content_record)) as { response: unknown }).response, observedAtMs: current.observedAtMs }
        : { schemaVersion: 1, state: 'unknown', reason: 'transport-error', observedAtMs: current.observedAtMs };
      const old = { ...receipt, schemaVersion: 1, outcome: oldOutcome };
      if (corrupt === 'receipt' && row.invocation_id === 'unknown-invocation') old.unexpected = true;
      downgrade.prepare('UPDATE model_invocations SET record=? WHERE invocation_id=?').run(JSON.stringify(old), String(row.invocation_id));
    }
    downgrade.exec(`DROP TABLE provider_spend_audits; DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts; DROP TABLE model_invocation_allocation_checkpoints; DROP INDEX model_invocations_allocation_identity;
      DROP TABLE model_invocation_cancellations; DROP TABLE model_invocation_controls;
      DROP TABLE model_invocation_contents; DROP TABLE model_invocation_content_purges; DROP INDEX model_invocations_allocation_state;
      ALTER TABLE model_invocations RENAME TO model_invocations_current;
      CREATE TABLE model_invocations(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,invocation_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('claimed','responded','unknown')),record TEXT NOT NULL,
        PRIMARY KEY(scope_id,invocation_id),UNIQUE(scope_id,command_id));
      INSERT INTO model_invocations SELECT * FROM model_invocations_current; DROP TABLE model_invocations_current;
      CREATE INDEX model_invocations_allocation_state ON model_invocations(scope_id,allocation_id,state); DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS agent_turn_tool_calls; DROP TABLE IF EXISTS agent_turns; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=14;`);
    if (corrupt === 'allocation') {
      const allocation = JSON.parse(String(downgrade.prepare('SELECT record FROM model_invocation_allocations').get()?.record));
      downgrade.prepare('UPDATE model_invocation_allocations SET lifetime_calls=?,record=?').run(1, JSON.stringify({ ...allocation, lifetimeCalls: 1 }));
    }
  } finally { downgrade.close(); }
}

async function seedV15(path: string, corrupt?: 'state' | 'identity' | 'count') {
  await seedV13(path);
  const activationDb = new DatabaseSync(path, { readOnly: true });
  const activation = JSON.parse(String(activationDb.prepare('SELECT record FROM model_activations').get()?.record)); activationDb.close();
  const historicalProfile = { ...profile(), allocation: { id: 'allocation', maxCalls: 4, maxInFlight: 4 } };
  const admit = (commandId: string, invocationId: string) => {
    const command = { schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
      nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: commandId }] } };
    return { command, requestDigest: modelInvocationRequestDigest(command), actor: { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' as const },
      authorization: { revision: 'policy', ruleId: 'invoke' }, definition, activation, profile: historicalProfile,
      profileDigest: modelInvocationProfileDigest(historicalProfile), invocationId, claimedAtMs: 10 };
  };
  const store = await openSqliteModelInvocationStore(path, options, 'allow');
  const responded = await store.claim(admit('responded', 'responded-id'));
  await store.permitSend(responded.record.receipt.claim, 'migration-fixture', 11);
  await store.recordResponse(responded.record.receipt.claim, { schemaVersion: 1, native: { id: 'legacy-response' }, usage: null }, 20);
  const rejected = await store.claim(admit('rejected', 'rejected-id'));
  await store.permitSend(rejected.record.receipt.claim, 'migration-fixture', 11);
  await store.recordRejected(rejected.record.receipt.claim,
    createModelInvocationResponseEvidence({ id: 'loopback-http', version: 1 }, 'http-status', 429, Buffer.from('legacy rejected'), true), 21);
  const partial = await store.claim(admit('partial', 'partial-id'));
  await store.permitSend(partial.record.receipt.claim, 'migration-fixture', 11);
  await store.recordUnknown(partial.record.receipt.claim, 'transport-error', 22,
    createModelInvocationResponseEvidence({ id: 'loopback-http', version: 1 }, 'interrupted', null, Buffer.from('legacy prefix'), false, 20));
  const unknown = await store.claim(admit('unknown', 'unknown-id'));
  await store.permitSend(unknown.record.receipt.claim, 'migration-fixture', 11);
  await store.recordUnknown(unknown.record.receipt.claim, 'transport-error', 23); store.close();
  const db = new DatabaseSync(path);
  try {
    for (const row of db.prepare(`SELECT i.invocation_id,i.record,c.record AS content_record FROM model_invocations i
      LEFT JOIN model_invocation_contents c ON c.scope_id=i.scope_id AND c.invocation_id=i.invocation_id`).all() as Array<Record<string, unknown>>) {
      const receipt = JSON.parse(String(row.record)) as Record<string, unknown>, outcome = receipt.outcome as Record<string, unknown>;
      const content = row.content_record === null ? null : JSON.parse(String(row.content_record)) as Record<string, unknown>;
      let oldOutcome: unknown;
      if (outcome.state === 'responded') oldOutcome = { schemaVersion: 2, state: 'responded', response: content?.response, observedAtMs: outcome.observedAtMs };
      else if (outcome.evidence === null) oldOutcome = { schemaVersion: 2, state: 'unknown', reason: 'transport-error', evidence: null, observedAtMs: outcome.observedAtMs };
      else {
        const withoutContent = { ...outcome }; delete withoutContent.content;
        oldOutcome = { ...withoutContent, schemaVersion: 2, evidence: { ...outcome.evidence, body: { ...outcome.evidence.body, data: content?.data } } };
      }
      db.prepare('UPDATE model_invocations SET record=? WHERE invocation_id=?').run(JSON.stringify({ ...receipt, schemaVersion: 2, outcome: oldOutcome }), String(row.invocation_id));
    }
    db.exec(`DROP TABLE provider_spend_audits; DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts; DROP TABLE model_invocation_allocation_checkpoints; DROP INDEX model_invocations_allocation_identity;
      DROP TABLE model_invocation_cancellations;
      DROP TABLE model_invocation_controls; DROP TABLE model_invocation_contents; DROP TABLE model_invocation_content_purges; DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS agent_turn_tool_calls; DROP TABLE IF EXISTS agent_turns; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=15;`);
    if (corrupt === 'state') db.prepare("UPDATE model_invocations SET state='claimed' WHERE invocation_id='rejected-id'").run();
    if (corrupt === 'identity') {
      const row = db.prepare("SELECT record FROM model_invocations WHERE invocation_id='responded-id'").get() as { record: string };
      const receipt = JSON.parse(row.record); receipt.claim.invocationId = 'other-id';
      db.prepare("UPDATE model_invocations SET record=? WHERE invocation_id='responded-id'").run(JSON.stringify(receipt));
    }
    if (corrupt === 'count') {
      const row = db.prepare('SELECT record FROM model_invocation_allocations').get() as { record: string };
      const allocation = JSON.parse(row.record); allocation.inFlight = 0;
      db.prepare('UPDATE model_invocation_allocations SET in_flight=?,record=?').run(0, JSON.stringify(allocation));
    }
  } finally { db.close(); }
}

function evidence(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { version: db.prepare('PRAGMA user_version').get()?.user_version,
    activation: db.prepare('SELECT revision,record FROM model_activations').all(),
    attempts: db.prepare('SELECT scope_id,attempt_id,snapshot FROM attempts').all(),
    runReceipts: db.prepare('SELECT command_id,command,snapshot FROM run_receipts').all() }; }
  finally { db.close(); }
}

it('migrates v13 activation and execution records to ledger17 without changing their payloads', async () => workspace(async path => {
  await seedV13(path); const before = evidence(path);
  const store = await openSqliteModelInvocationStore(path, options, 'allow'); store.close();
  expect(evidence(path)).toEqual({ ...before, version: CURRENT_LEDGER_VERSION });
  const db = new DatabaseSync(path, { readOnly: true });
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('model_invocations','model_invocation_contents') ORDER BY name").all())
    .toEqual([{ name: 'model_invocation_contents' }, { name: 'model_invocations' }]);
  db.close();
}));

it('forbids old ledgers from read-only access and rolls back a v14 table collision', async () => workspace(async path => {
  await seedV13(path); const before = evidence(path);
  await expect(openSqliteModelInvocationReader(path, { busyTimeoutMs: 20 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  expect(evidence(path)).toEqual(before);
  const db = new DatabaseSync(path); db.exec('CREATE TABLE model_invocations(marker TEXT)'); db.close();
  await expect(openSqliteModelInvocationStore(path, options, 'allow')).rejects.toThrow();
  expect(evidence(path)).toEqual(before);
  const inspect = new DatabaseSync(path, { readOnly: true });
  expect(String(inspect.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='model_invocations'").get()?.sql)).toContain('marker TEXT');
  inspect.close();
}));

it('chains genuine receipt1 v14 through receipt2 into separated receipt3/content records and rolls malformed history back', async () => {
  await workspace(async path => {
    await seedV14(path);
    const store = await openSqliteModelInvocationStore(path, options, 'allow'); store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
    const rows = db.prepare(`SELECT i.state,i.record,c.record AS content_record FROM model_invocations i
      LEFT JOIN model_invocation_contents c ON c.scope_id=i.scope_id AND c.invocation_id=i.invocation_id ORDER BY i.state`).all() as Array<Record<string, unknown>>;
    const responded = rows.find(row => row.state === 'responded')!, unknown = rows.find(row => row.state === 'unknown')!;
    expect((JSON.parse(String(responded.record)) as { schemaVersion: number; outcome: unknown }).schemaVersion).toBe(4);
    expect(String(responded.record)).not.toContain('historical sensitive body');
    expect(String(responded.content_record)).toContain('historical sensitive body');
    expect(JSON.parse(String(unknown.record))).toMatchObject({ schemaVersion: 4, outcome: { state: 'unknown', evidence: null, content: null } });
    expect(unknown.content_record).toBeNull();
    db.close();
  });
  for (const damage of ['receipt', 'allocation'] as const) await workspace(async path => {
    await seedV14(path, damage);
    const before = new DatabaseSync(path, { readOnly: true });
    const rows = before.prepare('SELECT * FROM model_invocations ORDER BY invocation_id').all();
    const allocations = before.prepare('SELECT * FROM model_invocation_allocations ORDER BY allocation_id').all(); before.close();
    await expect(openSqliteModelInvocationStore(path, options, 'allow')).rejects.toThrow('LEDGER_MIGRATION_EVIDENCE_REQUIRED');
    const after = new DatabaseSync(path, { readOnly: true });
    expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(14);
    expect(after.prepare('SELECT * FROM model_invocations ORDER BY invocation_id').all()).toEqual(rows);
    expect(after.prepare('SELECT * FROM model_invocation_allocations ORDER BY allocation_id').all()).toEqual(allocations);
    expect(after.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='model_invocation_contents'").all()).toEqual([]);
    after.close();
  });
});


it('migrates genuine receipt2 v15 responded, rejected, partial, and null-unknown records to receipt3/content and rejects inconsistent v15 inventory', async () => {
  await workspace(async path => {
    await seedV15(path);
    const store = await openSqliteModelInvocationStore(path, options, 'allow'); store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
    const rows = db.prepare(`SELECT i.state,i.record,c.record AS content_record FROM model_invocations i
      LEFT JOIN model_invocation_contents c ON c.scope_id=i.scope_id AND c.invocation_id=i.invocation_id ORDER BY i.state`).all() as Array<Record<string, unknown>>;
    expect(rows.map(row => row.state)).toEqual(['rejected', 'responded', 'unknown', 'unknown']);
    for (const row of rows) expect(JSON.parse(String(row.record))).toMatchObject({ schemaVersion: 4 });
    expect(rows.filter(row => row.content_record !== null)).toHaveLength(3);
    expect(String(rows.find(row => row.state === 'rejected')?.record)).not.toContain('legacy rejected');
    expect(String(rows.find(row => row.state === 'rejected')?.content_record)).toContain(Buffer.from('legacy rejected').toString('base64'));
    expect(rows.find(row => row.content_record === null)?.state).toBe('unknown'); db.close();
  });
  for (const damage of ['state', 'identity', 'count'] as const) await workspace(async path => {
    await seedV15(path, damage);
    const before = new DatabaseSync(path, { readOnly: true });
    const invocations = before.prepare('SELECT * FROM model_invocations ORDER BY invocation_id').all();
    const allocations = before.prepare('SELECT * FROM model_invocation_allocations').all(); before.close();
    await expect(openSqliteModelInvocationStore(path, options, 'allow')).rejects.toThrow('LEDGER_MIGRATION_EVIDENCE_REQUIRED');
    const after = new DatabaseSync(path, { readOnly: true });
    expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(15);
    expect(after.prepare('SELECT * FROM model_invocations ORDER BY invocation_id').all()).toEqual(invocations);
    expect(after.prepare('SELECT * FROM model_invocation_allocations').all()).toEqual(allocations);
    expect(after.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='model_invocation_contents'").all()).toEqual([]); after.close();
  });
});
