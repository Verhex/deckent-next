import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelAllocationIntegrityReader,
  openSqliteModelInvocationReader, openSqliteModelInvocationStore } from '#adapters/index.js';
import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { createModelInvocationResponseEvidence, modelInvocationProfileDigest, modelInvocationRequestDigest,
  verifyModelAllocationIntegrity } from '#engine/index.js';

const execute = promisify(execFile), roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;
const authorization = { revision: 'policy', ruleId: 'invoke' };

async function file() { const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-')); roots.push(root); return join(root, 'ledger.db'); }
async function fixture(maxCalls = 3, maxInFlight = 2) {
  const path = await file(), activations = await openSqliteModelActivationStore(path, options);
  const activated = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  activations.close();
  const profile = { schemaVersion: 1 as const, id: 'local-profile', version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'loopback-http', version: 1, definition: { origin: 'http://127.0.0.1:1' } },
    allocation: { id: 'allocation', maxCalls, maxInFlight }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1_000 } };
  return { path, activation: activated.receipt.record, profile };
}
function admission(base: Awaited<ReturnType<typeof fixture>>, commandId: string, invocationId: string, prompt = 'private prompt') {
  const command = { schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: prompt }] } };
  return { command, requestDigest: modelInvocationRequestDigest(command), actor, authorization, definition, activation: base.activation,
    profile: base.profile, profileDigest: modelInvocationProfileDigest(base.profile), invocationId, claimedAtMs: 10 };
}
function row(db: DatabaseSync, table: string, invocationId: string) {
  return db.prepare(`SELECT record FROM ${table} WHERE scope_id=? AND invocation_id=?`).get('scope', invocationId) as { record: string } | undefined;
}

it('claims one canonical record, replays it, and retains a null-content unknown claim in capacity', async () => {
  const base = await fixture(2, 1), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const input = admission(base, 'command-1', 'invocation-1'), first = await store.claim(input);
  expect(first).toMatchObject({ replayed: false, record: { receipt: { outcome: null }, content: null } });
  expect(await store.claim({ ...input, invocationId: 'ignored-on-replay' })).toEqual({ replayed: true, record: first.record });
  await store.permitSend(first.record.receipt.claim, 'sender', 10);
  const unknown = await store.recordUnknown(first.record.receipt.claim, 'transport-error', 11);
  expect(unknown).toMatchObject({ receipt: { outcome: { schemaVersion: 4, state: 'unknown', evidence: null, content: null } }, content: null });
  await expect(store.claim(admission(base, 'command-2', 'invocation-2'))).rejects.toThrow('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
  store.close();
  const db = new DatabaseSync(base.path, { readOnly: true });
  expect(db.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get()).toEqual({ lifetime_calls: 1, in_flight: 1 });
  expect(db.prepare('SELECT count(*) AS count FROM model_invocation_contents').get()?.count).toBe(0);
  expect(String(row(db, 'model_invocations', 'invocation-1')?.record)).not.toContain('private prompt');
  db.close();
});

it('separates native response content from the durable receipt and returns the same record without resettling', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const claim = await store.claim(admission(base, 'command-1', 'invocation-1'));
  const response = { schemaVersion: 1 as const, native: { id: 'secret-response', choices: [{ message: { content: 'sensitive result' } }] }, usage: { total_tokens: 3 } };
  await store.permitSend(claim.record.receipt.claim, 'sender', 19);
  const settled = await store.recordResponse(claim.record.receipt.claim, response, 20);
  expect(settled.receipt.outcome).toMatchObject({ schemaVersion: 4, state: 'responded', content: { kind: 'native-response', encoding: 'canonical-json' } });
  expect(settled.content).toMatchObject({ kind: 'native-response', response });
  expect(await store.recordResponse(claim.record.receipt.claim, response, 20)).toEqual(settled);
  store.close();
  const db = new DatabaseSync(base.path, { readOnly: true });
  const receipt = String(row(db, 'model_invocations', 'invocation-1')?.record), content = String(row(db, 'model_invocation_contents', 'invocation-1')?.record);
  expect(receipt).not.toContain('sensitive result');
  expect(content).toContain('sensitive result');
  expect(JSON.parse(content).descriptor).toEqual((JSON.parse(receipt).outcome as { content: unknown }).content);
  expect(db.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get()).toEqual({ lifetime_calls: 1, in_flight: 0 });
  db.close();
});

it('keeps only evidence summaries in rejected and partial receipts while preserving raw content separately', async () => {
  const completeBytes = Buffer.from('{"error":"sensitive denied"}');
  const complete = createModelInvocationResponseEvidence({ id: 'loopback-http', version: 1 }, 'http-status', 429, completeBytes, true);
  const rejectedBase = await fixture(), rejectedStore = await openSqliteModelInvocationStore(rejectedBase.path, options, 'forbid');
  const rejectedClaim = await rejectedStore.claim(admission(rejectedBase, 'reject', 'reject-id'));
  await rejectedStore.permitSend(rejectedClaim.record.receipt.claim, 'sender', 29);
  const rejected = await rejectedStore.recordRejected(rejectedClaim.record.receipt.claim, complete, 30);
  expect(rejected).toMatchObject({ receipt: { outcome: { state: 'rejected', evidence: { body: { digest: complete.body.digest } }, content: { kind: 'response-body' } } },
    content: { kind: 'response-body', data: complete.body.data } });
  rejectedStore.close();
  const rejectedDb = new DatabaseSync(rejectedBase.path, { readOnly: true });
  expect(String(row(rejectedDb, 'model_invocations', 'reject-id')?.record)).not.toContain('sensitive denied');
  expect(String(row(rejectedDb, 'model_invocation_contents', 'reject-id')?.record)).toContain(complete.body.data);
  rejectedDb.close();

  const partialBase = await fixture(2, 1), partialStore = await openSqliteModelInvocationStore(partialBase.path, options, 'forbid');
  const partialClaim = await partialStore.claim(admission(partialBase, 'partial', 'partial-id'));
  const partial = createModelInvocationResponseEvidence({ id: 'loopback-http', version: 1 }, 'interrupted', null, Buffer.from('prefix'), false, 10);
  await partialStore.permitSend(partialClaim.record.receipt.claim, 'sender', 30);
  const unknown = await partialStore.recordUnknown(partialClaim.record.receipt.claim, 'transport-error', 31, partial);
  expect(unknown.receipt.outcome).toMatchObject({ state: 'unknown', evidence: { body: { observedBytes: 10, complete: false } }, content: { kind: 'response-body' } });
  expect(unknown.content).toMatchObject({ kind: 'response-body', data: partial.body.data });
  await expect(partialStore.claim(admission(partialBase, 'blocked', 'blocked-id'))).rejects.toThrow('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
  partialStore.close();
});

it('rolls back allocation and receipt writes when the content insert fails', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const claim = await store.claim(admission(base, 'command-1', 'invocation-1'));
  await store.permitSend(claim.record.receipt.claim, 'sender', 19); store.close();
  const db = new DatabaseSync(base.path);
  db.exec(`CREATE TRIGGER reject_content BEFORE INSERT ON model_invocation_contents
    BEGIN SELECT RAISE(ABORT,'fixture content failure'); END;`);
  db.close();
  const failing = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await expect(failing.recordResponse(claim.record.receipt.claim, { schemaVersion: 1, native: { id: 'result' }, usage: null }, 20))
    .rejects.toThrow('MODEL_INVOCATION_UNAVAILABLE');
  failing.close();
  const check = new DatabaseSync(base.path, { readOnly: true });
  expect(JSON.parse(String(row(check, 'model_invocations', 'invocation-1')?.record)).outcome).toBeNull();
  expect(check.prepare('SELECT count(*) AS count FROM model_invocation_contents').get()?.count).toBe(0);
  expect(check.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get()).toEqual({ lifetime_calls: 1, in_flight: 1 });
  check.close();
});

it('fails closed on missing, extra, or descriptor-corrupted content rows', async () => {
  const base = await fixture(4, 4), seed = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const responseClaim = await seed.claim(admission(base, 'response', 'response-id'));
  await seed.permitSend(responseClaim.record.receipt.claim, 'sender', 19);
  await seed.recordResponse(responseClaim.record.receipt.claim, { schemaVersion: 1, native: { id: 'result' }, usage: null }, 20);
  const claimed = await seed.claim(admission(base, 'claimed', 'claimed-id')); seed.close();
  const mutate = new DatabaseSync(base.path);
  mutate.prepare('DELETE FROM model_invocation_contents WHERE scope_id=? AND invocation_id=?').run('scope', 'response-id');
  mutate.prepare('INSERT INTO model_invocation_contents(scope_id,invocation_id,record) VALUES(?,?,?)')
    .run('scope', 'claimed-id', JSON.stringify({ schemaVersion: 1, kind: 'response-body', descriptor: { schemaVersion: 1, kind: 'response-body', encoding: 'base64', digest: '0'.repeat(64), byteLength: 0 }, data: '' }));
  mutate.close();
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await expect(store.loadInvocation('scope', 'response-id')).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
  await expect(store.loadInvocation('scope', claimed.record.receipt.claim.invocationId)).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
  store.close();

  const descriptorBase = await fixture(), descriptorStore = await openSqliteModelInvocationStore(descriptorBase.path, options, 'forbid');
  const descriptorClaim = await descriptorStore.claim(admission(descriptorBase, 'descriptor', 'descriptor-id'));
  await descriptorStore.permitSend(descriptorClaim.record.receipt.claim, 'sender', 19);
  await descriptorStore.recordResponse(descriptorClaim.record.receipt.claim, { schemaVersion: 1, native: { id: 'result' }, usage: null }, 20);
  descriptorStore.close();
  const damage = new DatabaseSync(descriptorBase.path);
  const content = JSON.parse(String(row(damage, 'model_invocation_contents', 'descriptor-id')?.record));
  content.descriptor.digest = '0'.repeat(64);
  damage.prepare('UPDATE model_invocation_contents SET record=? WHERE scope_id=? AND invocation_id=?').run(JSON.stringify(content), 'scope', 'descriptor-id');
  damage.close();
  const reader = await openSqliteModelInvocationReader(descriptorBase.path, { busyTimeoutMs: 20 });
  await expect(reader.loadInvocation('scope', 'descriptor-id')).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
  reader.close();
});


it('releases in-flight once for a definitive response while lifetime count never resets', async () => {
  const base = await fixture(2, 1), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const first = await store.claim(admission(base, 'command-1', 'invocation-1'));
  const response = { schemaVersion: 1 as const, native: { id: 'response-1', choices: [] }, usage: { total_tokens: 3 } };
  await store.permitSend(first.record.receipt.claim, 'sender', 18);
  await expect(store.recordResponse(first.record.receipt.claim,
    { schemaVersion: 1, native: { body: 'x'.repeat(5_000) }, usage: null }, 19)).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
  expect((await store.loadInvocation('scope', 'invocation-1'))?.receipt.outcome).toBeNull();
  const settled = await store.recordResponse(first.record.receipt.claim, response, 20);
  expect(await store.recordResponse(first.record.receipt.claim, response, 20)).toEqual(settled);
  const second = await store.claim(admission(base, 'command-2', 'invocation-2'));
  await expect(store.claim(admission(base, 'command-3', 'invocation-3'))).rejects.toThrow('MODEL_INVOCATION_QUOTA_EXHAUSTED');
  expect(second.record.receipt.outcome).toBeNull(); store.close();
  const db = new DatabaseSync(base.path, { readOnly: true });
  expect(db.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get()).toEqual({ lifetime_calls: 2, in_flight: 1 }); db.close();
});

it('reports immutable allocation ceiling conflicts without mutation and rolls all claim writes back when insertion fails', async () => {
  const base = await fixture(3, 2), seed = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const first = await seed.claim(admission(base, 'command-1', 'invocation-1')); seed.close();
  const beforeDb = new DatabaseSync(base.path, { readOnly: true });
  const beforeAllocation = beforeDb.prepare('SELECT * FROM model_invocation_allocations').get();
  const beforeInvocations = beforeDb.prepare('SELECT count(*) AS count FROM model_invocations').get(); beforeDb.close();
  const conflict = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  for (const [suffix, allocation] of [
    ['calls', { ...base.profile.allocation, maxCalls: 4 }],
    ['flight', { ...base.profile.allocation, maxInFlight: 3 }],
  ] as const) {
    const changed = { ...base, profile: { ...base.profile, version: 2, allocation } };
    await expect(conflict.claim(admission(changed, `command-${suffix}`, `invocation-${suffix}`)))
      .rejects.toThrow('MODEL_INVOCATION_ALLOCATION_CONFLICT');
  }
  conflict.close();
  const unchanged = new DatabaseSync(base.path, { readOnly: true });
  expect(unchanged.prepare('SELECT * FROM model_invocation_allocations').get()).toEqual(beforeAllocation);
  expect(unchanged.prepare('SELECT count(*) AS count FROM model_invocations').get()).toEqual(beforeInvocations); unchanged.close();
  const db = new DatabaseSync(base.path); db.exec(`CREATE TRIGGER reject_invocation BEFORE INSERT ON model_invocations
    WHEN NEW.command_id='command-2' BEGIN SELECT RAISE(ABORT,'fixture invocation failure'); END;`); db.close();
  const failing = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await failing.permitSend(first.record.receipt.claim, 'sender', 19);
  await failing.recordResponse(first.record.receipt.claim, { schemaVersion: 1, native: {}, usage: null }, 20);
  await expect(failing.claim(admission(base, 'command-2', 'invocation-2'))).rejects.toThrow('MODEL_INVOCATION_UNAVAILABLE'); failing.close();
  const check = new DatabaseSync(base.path, { readOnly: true });
  expect(check.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get()).toEqual({ lifetime_calls: 1, in_flight: 0 });
  expect(check.prepare('SELECT count(*) AS count FROM model_invocations').get()?.count).toBe(1); check.close();
});

it('fails closed for stale activation and corrupt allocation counters', async () => {
  const stale = await fixture(), staleDb = new DatabaseSync(stale.path);
  staleDb.prepare('UPDATE model_activations SET revision=?').run(2); staleDb.close();
  const staleStore = await openSqliteModelInvocationStore(stale.path, options, 'forbid');
  await expect(staleStore.claim(admission(stale, 'command-1', 'invocation-1'))).rejects.toThrow('MODEL_INVOCATION_ACTIVATION_CONFLICT');
  staleStore.close();

  const corrupt = await fixture(3, 2), seed = await openSqliteModelInvocationStore(corrupt.path, options, 'forbid');
  await seed.claim(admission(corrupt, 'command-1', 'invocation-1')); seed.close();
  const corruptDb = new DatabaseSync(corrupt.path);
  const allocation = JSON.parse(String(corruptDb.prepare('SELECT record FROM model_invocation_allocations').get()?.record)) as Record<string, unknown>;
  corruptDb.prepare('UPDATE model_invocation_allocations SET lifetime_calls=?,record=?').run(2, JSON.stringify({ ...allocation, lifetimeCalls: 2 })); corruptDb.close();
  const corruptStore = await openSqliteModelInvocationStore(corrupt.path, options, 'forbid');
  await expect(corruptStore.claim(admission(corrupt, 'command-2', 'invocation-2'))).rejects.toThrow('MODEL_INVOCATION_CORRUPT'); corruptStore.close();

});

it('fails closed when an allocation row is missing behind canonical invocation history', async () => {
  const base = await fixture(3, 2), seed = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await seed.claim(admission(base, 'command-1', 'invocation-1')); seed.close();
  const damage = new DatabaseSync(base.path);
  damage.exec('PRAGMA foreign_keys=OFF');
  damage.prepare('DELETE FROM model_invocation_allocations WHERE scope_id=? AND allocation_id=?').run('scope', 'allocation'); damage.close();
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await expect(store.claim(admission(base, 'command-2', 'invocation-2'))).rejects.toThrow('MODEL_INVOCATION_CORRUPT'); store.close();
  const check = new DatabaseSync(base.path, { readOnly: true });
  expect(check.prepare('SELECT count(*) AS count FROM model_invocation_allocations').get()?.count).toBe(0);
  expect(check.prepare('SELECT count(*) AS count FROM model_invocations').get()?.count).toBe(1); check.close();
});

it('rejects canonical receipt substitution and detects missing canonical history in the read-only integrity audit', async () => {
  const substituted = await fixture(3, 2), seed = await openSqliteModelInvocationStore(substituted.path, options, 'forbid');
  await seed.claim(admission(substituted, 'command-1', 'invocation-1'));
  await seed.claim(admission(substituted, 'command-2', 'invocation-2')); seed.close();
  const substituteDb = new DatabaseSync(substituted.path);
  const secondRecord = substituteDb.prepare('SELECT record FROM model_invocations WHERE invocation_id=?').get('invocation-2')?.record;
  substituteDb.prepare('UPDATE model_invocations SET record=? WHERE invocation_id=?').run(secondRecord, 'invocation-1'); substituteDb.close();
  const substitutedStore = await openSqliteModelInvocationStore(substituted.path, options, 'forbid');
  await expect(substitutedStore.loadReceipt('scope', 'command-1')).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
  await expect(substitutedStore.loadInvocation('scope', 'invocation-1')).rejects.toThrow('MODEL_INVOCATION_CORRUPT'); substitutedStore.close();

  const missing = await fixture(3, 2), missingSeed = await openSqliteModelInvocationStore(missing.path, options, 'forbid');
  await missingSeed.claim(admission(missing, 'command-1', 'invocation-1')); missingSeed.close();
  const missingDb = new DatabaseSync(missing.path);
  missingDb.prepare('DELETE FROM model_invocation_controls WHERE scope_id=? AND invocation_id=?').run('scope', 'invocation-1');
  missingDb.prepare('DELETE FROM model_invocations WHERE scope_id=? AND command_id=?').run('scope', 'command-1'); missingDb.close();
  const beforeAudit = await readFile(missing.path);
  const integrity = await openSqliteModelAllocationIntegrityReader(missing.path, { busyTimeoutMs: options.busyTimeoutMs });
  try { await expect(verifyModelAllocationIntegrity(integrity, 'scope', 'allocation', 1)).rejects.toThrow('MODEL_INVOCATION_CORRUPT'); }
  finally { integrity.close(); }
  expect(await readFile(missing.path)).toEqual(beforeAudit);
  const check = new DatabaseSync(missing.path, { readOnly: true });
  expect(check.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get()).toEqual({ lifetime_calls: 1, in_flight: 1 }); check.close();
});

it('migrates schema13 to current without changing activation rows and read-only access never creates or migrates', async () => {
  const path = await file();
  const current = await openSqliteModelActivationStore(path, options); current.close();
  const db = new DatabaseSync(path);
  // Reconstruct a complete v13 ledger, including its existing execution/receipt tables.
  db.exec(`DROP TABLE provider_spend_audits; DROP TABLE model_invocation_spend_reservations;
    DROP TABLE provider_spend_accounts; DROP TABLE model_invocation_allocation_checkpoints;
    DROP TABLE model_invocation_cancellations; DROP TABLE model_invocation_controls;
    DROP TABLE model_invocation_contents; DROP TABLE model_invocation_content_purges;
    DROP TABLE model_invocations; DROP TABLE model_invocation_allocations; DROP TABLE IF EXISTS run_execution_intents; DROP TABLE IF EXISTS task_evaluation_observations; DROP TABLE IF EXISTS workspace_integrations; PRAGMA user_version=13;`);
  db.prepare('INSERT INTO model_activations VALUES(?,?,?,?,?,?,?)').run('scope', 'provider', 1, 'model', 1, 1, '{"preserved":true}'); db.close();
  const beforeDb = new DatabaseSync(path, { readOnly: true }), before = beforeDb.prepare('SELECT * FROM model_activations').all(); beforeDb.close();
  const oldBytes = await readFile(path);
  await expect(openSqliteModelInvocationReader(path, { busyTimeoutMs: 10 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  expect(await readFile(path)).toEqual(oldBytes);
  const writer = await openSqliteModelInvocationStore(path, options, 'allow'); writer.close();
  const migrated = new DatabaseSync(path, { readOnly: true }); expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
  expect(migrated.prepare('SELECT * FROM model_activations').all()).toEqual(before); migrated.close();
  const reader = await openSqliteModelInvocationReader(path, { busyTimeoutMs: 10 });
  expect('claim' in reader).toBe(false); expect('recordResponse' in reader).toBe(false); reader.close();
  const missing = await file(); await expect(openSqliteModelInvocationReader(missing, { busyTimeoutMs: 10 })).rejects.toThrow('MODEL_INVOCATION_UNAVAILABLE');
  await expect(access(missing)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('allows exactly one process to claim the final in-flight slot', async () => {
  const entry = resolve('dist/adapters/core/sqlite-model-invocation/index.js');
  await access(entry).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const base = await fixture(2, 1), encoded = ['command-a', 'command-b'].map((commandId, index) =>
    Buffer.from(JSON.stringify(admission(base, commandId, `invocation-${index}`))).toString('base64url'));
  const child = resolve('tests/fixtures/model-invocation-claim.mjs');
  const results = await Promise.all(encoded.map(value => execute(process.execPath, [child, base.path, value],
    { cwd: process.cwd(), timeout: 10_000, maxBuffer: 1_048_576 })));
  const outcomes = results.map(result => JSON.parse(result.stdout.trim()) as { ok: boolean; code?: string });
  expect(outcomes.filter(value => value.ok)).toHaveLength(1);
  expect(outcomes.filter(value => value.code === 'MODEL_INVOCATION_CAPACITY_EXHAUSTED')).toHaveLength(1);
});

it('converges two processes racing the same command on one canonical claim', async () => {
  const entry = resolve('dist/adapters/core/sqlite-model-invocation/index.js');
  await access(entry).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const base = await fixture(2, 2), commandId = 'shared-command';
  const encoded = ['proposed-invocation-a', 'proposed-invocation-b'].map(invocationId =>
    Buffer.from(JSON.stringify(admission(base, commandId, invocationId))).toString('base64url'));
  const child = resolve('tests/fixtures/model-invocation-claim.mjs');
  const results = await Promise.all(encoded.map(value => execute(process.execPath, [child, base.path, value],
    { cwd: process.cwd(), timeout: 10_000, maxBuffer: 1_048_576 })));
  const outcomes = results.map(result => JSON.parse(result.stdout.trim()) as { ok: boolean; replayed?: boolean; invocationId?: string; code?: string });
  expect(outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true, replayed: false }), expect.objectContaining({ ok: true, replayed: true })]));
  expect(new Set(outcomes.map(value => value.invocationId)).size).toBe(1);
  const db = new DatabaseSync(base.path, { readOnly: true });
  expect(db.prepare('SELECT count(*) AS count FROM model_invocations WHERE scope_id=? AND command_id=?').get('scope', commandId)?.count).toBe(1);
  expect(db.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations WHERE scope_id=? AND allocation_id=?').get('scope', 'allocation'))
    .toEqual({ lifetime_calls: 1, in_flight: 1 }); db.close();
});
