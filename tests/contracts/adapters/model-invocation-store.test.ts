import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { createModelInvocationResponseEvidence, modelInvocationProfileDigest,
  modelInvocationRequestDigest } from '#engine/core/model-invocation/index.js';
import { openSqliteModelActivationStore } from '#adapters/core/sqlite-model-activation/index.js';
import { openSqliteModelInvocationReader, openSqliteModelInvocationStore } from '#adapters/core/sqlite-model-invocation/index.js';

const execute = promisify(execFile), roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'openai-chat-completions', version: '1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;
const authorization = { revision: 'policy', ruleId: 'invoke' };
async function file() { const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-')); roots.push(root); return join(root, 'ledger.db'); }
async function fixture(maxCalls = 2, maxInFlight = 1) {
  const path = await file(), activationStore = await openSqliteModelActivationStore(path, options);
  const activated = await activationStore.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition }); activationStore.close();
  const profile = { schemaVersion: 1 as const, id: 'local-profile', version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: '1' },
    adapter: { id: 'loopback-http', version: 1, definition: { origin: 'http://127.0.0.1:1' } },
    allocation: { id: 'allocation', maxCalls, maxInFlight }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  return { path, activation: activated.receipt.record, profile };
}
function admission(base: Awaited<ReturnType<typeof fixture>>, commandId: string, invocationId: string, prompt = 'private prompt') {
  const command = { schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: prompt }] } };
  return { command, requestDigest: modelInvocationRequestDigest(command), actor, authorization, definition,
    activation: base.activation, profile: base.profile, profileDigest: modelInvocationProfileDigest(base.profile), invocationId, claimedAtMs: 10 };
}

it('claims atomically, replays exact commands without storing prompts, and retains unknown capacity', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const firstInput = admission(base, 'command-1', 'invocation-1'), first = await store.claim(firstInput);
  expect(first).toMatchObject({ replayed: false, receipt: { outcome: null, claim: { invocationId: 'invocation-1' } } });
  expect(await store.claim(firstInput)).toEqual({ replayed: true, receipt: first.receipt });
  expect(await store.claim({ ...firstInput, invocationId: 'different-server-id' })).toEqual({ replayed: true, receipt: first.receipt });
  await expect(store.claim({ ...firstInput, actor: { ...actor, subject: '1001' } })).rejects.toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
  await expect(store.claim(admission(base, 'command-2', 'invocation-2'))).rejects.toThrow('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
  const unknown = await store.recordUnknown(first.receipt.claim, 'transport-error', 11);
  expect(unknown.outcome).toEqual({ schemaVersion: 2, state: 'unknown', reason: 'transport-error', evidence: null, observedAtMs: 11 });
  await expect(store.claim(admission(base, 'command-2', 'invocation-2'))).rejects.toThrow('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
  store.close();
  const db = new DatabaseSync(base.path, { readOnly: true });
  expect(db.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get()).toEqual({ lifetime_calls: 1, in_flight: 1 });
  expect(db.prepare('SELECT count(*) AS count FROM model_invocations WHERE scope_id=? AND command_id=?')
    .get('scope', 'command-1')?.count).toBe(1);
  expect(JSON.stringify(db.prepare('SELECT record FROM model_invocations').get())).not.toContain('private prompt'); db.close();
});

it('releases in-flight once for a definitive response while lifetime count never resets', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const first = await store.claim(admission(base, 'command-1', 'invocation-1'));
  const response = { schemaVersion: 1 as const, native: { id: 'response-1', choices: [] }, usage: { total_tokens: 3 } };
  await expect(store.recordResponse(first.receipt.claim,
    { schemaVersion: 1, native: { body: 'x'.repeat(5_000) }, usage: null }, 19)).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
  expect((await store.loadInvocation('scope', 'invocation-1'))?.outcome).toBeNull();
  const settled = await store.recordResponse(first.receipt.claim, response, 20);
  expect(await store.recordResponse(first.receipt.claim, response, 20)).toEqual(settled);
  const second = await store.claim(admission(base, 'command-2', 'invocation-2'));
  await expect(store.claim(admission(base, 'command-3', 'invocation-3'))).rejects.toThrow('MODEL_INVOCATION_QUOTA_EXHAUSTED');
  expect(second.receipt.outcome).toBeNull(); store.close();
  const db = new DatabaseSync(base.path, { readOnly: true });
  expect(db.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get()).toEqual({ lifetime_calls: 2, in_flight: 1 }); db.close();
});

it('releases complete rejected responses while incomplete response evidence remains unknown and retains capacity', async () => {
  const bytes = Buffer.from('{"error":"denied"}'), complete = createModelInvocationResponseEvidence(
    { id: 'loopback-http', version: 1 }, 'http-status', 429, bytes, true);
  const rejectedBase = await fixture(2, 1), rejectedStore = await openSqliteModelInvocationStore(rejectedBase.path, options, 'forbid');
  const rejectedClaim = await rejectedStore.claim(admission(rejectedBase, 'rejected', 'rejected-invocation'));
  const rejected = await rejectedStore.recordRejected(rejectedClaim.receipt.claim, complete, 30);
  expect(rejected.outcome).toEqual({ schemaVersion: 2, state: 'rejected', evidence: complete, observedAtMs: 30 });
  expect(await rejectedStore.recordRejected(rejectedClaim.receipt.claim, complete, 30)).toEqual(rejected);
  await expect(rejectedStore.claim(admission(rejectedBase, 'after-rejected', 'after-rejected-invocation'))).resolves
    .toMatchObject({ replayed: false });
  rejectedStore.close();

  const partialBase = await fixture(2, 1), partialStore = await openSqliteModelInvocationStore(partialBase.path, options, 'forbid');
  const partialClaim = await partialStore.claim(admission(partialBase, 'partial', 'partial-invocation'));
  const partial = createModelInvocationResponseEvidence({ id: 'loopback-http', version: 1 },
    'interrupted', null, Buffer.alloc(0), false, 1);
  await expect(partialStore.recordRejected(partialClaim.receipt.claim, partial, 31)).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
  expect((await partialStore.loadInvocation('scope', 'partial-invocation'))?.outcome).toBeNull();
  const unknown = await partialStore.recordUnknown(partialClaim.receipt.claim, 'transport-error', 31, partial);
  expect(unknown.outcome).toEqual({ schemaVersion: 2, state: 'unknown', reason: 'transport-error', evidence: partial, observedAtMs: 31 });
  await expect(partialStore.claim(admission(partialBase, 'blocked', 'blocked-invocation')))
    .rejects.toThrow('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
  partialStore.close();
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
  await failing.recordResponse(first.receipt.claim, { schemaVersion: 1, native: {}, usage: null }, 20);
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
  corruptDb.prepare('UPDATE model_invocation_allocations SET lifetime_calls=?,record=?').run(2, JSON.stringify({ ...allocation, lifetimeCalls: 2 }));
  corruptDb.close();
  const corruptStore = await openSqliteModelInvocationStore(corrupt.path, options, 'forbid');
  await expect(corruptStore.claim(admission(corrupt, 'command-2', 'invocation-2'))).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
  corruptStore.close();
});

it('fails closed when an allocation row is missing behind canonical invocation history', async () => {
  const base = await fixture(3, 2), seed = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await seed.claim(admission(base, 'command-1', 'invocation-1')); seed.close();
  const damage = new DatabaseSync(base.path);
  damage.prepare('DELETE FROM model_invocation_allocations WHERE scope_id=? AND allocation_id=?').run('scope', 'allocation');
  damage.close();
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await expect(store.claim(admission(base, 'command-2', 'invocation-2'))).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
  store.close();
  const check = new DatabaseSync(base.path, { readOnly: true });
  expect(check.prepare('SELECT count(*) AS count FROM model_invocation_allocations').get()?.count).toBe(0);
  expect(check.prepare('SELECT count(*) AS count FROM model_invocations').get()?.count).toBe(1);
  check.close();
});

it('rejects canonical receipt substitution and missing canonical history behind retained counters', async () => {
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
  missingDb.prepare('DELETE FROM model_invocations WHERE scope_id=? AND command_id=?').run('scope', 'command-1'); missingDb.close();
  const missingStore = await openSqliteModelInvocationStore(missing.path, options, 'forbid');
  await expect(missingStore.claim(admission(missing, 'command-1', 'replacement-invocation'))).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
  missingStore.close();
  const missingCheck = new DatabaseSync(missing.path, { readOnly: true });
  expect(missingCheck.prepare('SELECT count(*) AS count FROM model_invocations').get()?.count).toBe(0);
  expect(missingCheck.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get())
    .toEqual({ lifetime_calls: 1, in_flight: 1 });
  missingCheck.close();
});

it('migrates schema 13 to 15 without changing activation rows and read-only access never creates or migrates', async () => {
  const path = await file(), db = new DatabaseSync(path); db.exec(`PRAGMA user_version=13;
    CREATE TABLE model_activations(scope_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_version INTEGER NOT NULL,
      model_id TEXT NOT NULL,model_version INTEGER NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(scope_id,provider_id,provider_version,model_id,model_version));
    CREATE TABLE model_activation_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));`);
  db.prepare('INSERT INTO model_activations VALUES(?,?,?,?,?,?,?)').run('scope', 'provider', 1, 'model', 1, 1, '{"preserved":true}'); db.close();
  const beforeDb = new DatabaseSync(path, { readOnly: true }), before = beforeDb.prepare('SELECT * FROM model_activations').all(); beforeDb.close();
  const oldBytes = await readFile(path);
  await expect(openSqliteModelInvocationReader(path, { busyTimeoutMs: 10 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  expect(await readFile(path)).toEqual(oldBytes);
  const writer = await openSqliteModelInvocationStore(path, options, 'allow'); writer.close();
  const migrated = new DatabaseSync(path, { readOnly: true }); expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(15);
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
  const outcomes = results.map(result => JSON.parse(result.stdout.trim()) as
    { ok: boolean; replayed?: boolean; invocationId?: string; code?: string });
  expect(outcomes).toEqual(expect.arrayContaining([
    expect.objectContaining({ ok: true, replayed: false }),
    expect.objectContaining({ ok: true, replayed: true }),
  ]));
  expect(new Set(outcomes.map(value => value.invocationId)).size).toBe(1);
  const db = new DatabaseSync(base.path, { readOnly: true });
  expect(db.prepare('SELECT count(*) AS count FROM model_invocations WHERE scope_id=? AND command_id=?')
    .get('scope', commandId)?.count).toBe(1);
  expect(db.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations WHERE scope_id=? AND allocation_id=?')
    .get('scope', 'allocation')).toEqual({ lifetime_calls: 1, in_flight: 1 });
  db.close();
});
