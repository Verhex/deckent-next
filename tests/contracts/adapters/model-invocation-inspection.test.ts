import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteModelInvocationStore } from '#adapters/index.js';
import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { encodeModelBindingDefinition, memoryDistillerPrincipal, parseProviderCatalog, resolveModelBindingDefinition, type RateLimitFact } from '#domain/index.js';
import type { ClaudeRateLimit } from '#capabilities/index.js';
import { ModelInvocationInspectionApplication, verifiedPrincipal, parseModelInvocationInspectionForQuery, createModelInvocationResponseEvidence, createModelInvocationPlanUsage, modelInvocationPlanUsageDigest, verifyModelInvocationPlanUsage, modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';

const roots: string[] = [], options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;

async function fixture(outcome?: 'responded' | 'rejected' | 'unknown', settings: { path?: string; scope?: string; model?: string; id?: string; plugins?: readonly string[]; wal?: boolean } = {}) {
  const scopeId = settings.scope ?? 'scope', invocationId = settings.id ?? 'invocation';
  const commandId = settings.id ?? 'invoke', reference = { providerId: 'provider', providerVersion: 1, modelId: settings.model ?? 'model', modelVersion: 1 };
  const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'provider', version: 1,
    models: [{ id: reference.modelId, version: 1, nativeId: 'native/model', protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] }] }), reference)!;
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-inspection-')); roots.push(root);
  const storage = settings.wal ? { ...options, journalMode: 'wal' as const } : options;
  const path = settings.path ?? join(root, 'ledger.db'), activations = await openSqliteModelActivationStore(path, storage);
  const activated = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: `activate-${scopeId}-${reference.modelId}`, scopeId,
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition }); activations.close();
  const profile = { ...(outcome ? { schemaVersion: 2 as const, billingAxis: 'subscription' as const } : { schemaVersion: 1 as const }), id: 'profile', version: 1, scopeId, reference,
    bindingDigest: binding.digest, protocol: { family: 'chat', version: '1' }, adapter: { id: 'adapter', version: 1, definition: {} },
    allocation: { id: 'allocation', maxCalls: outcome ? null : 2, maxInFlight: 2 }, limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } };
  const command = { schemaVersion: 1 as const, commandId, scopeId, reference,
    catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: { prompt: 'private' } };
  const store = await openSqliteModelInvocationStore(path, storage, 'forbid');
  const claimed = await store.claim({ command, requestDigest: modelInvocationRequestDigest(command), actor,
    authorization: { revision: 'policy', ruleId: 'invoke' }, definition, activation: activated.receipt.record, profile,
    profileDigest: modelInvocationProfileDigest(profile), invocationId, claimedAtMs: 2 });
  await store.permitSend(claimed.record.receipt.claim, 'runtime-owner', 3);
  const cancellation = { command: { schemaVersion: 1 as const, commandId: settings.id ? `cancel-${settings.id}` : 'cancel', scopeId, targetCommandId: commandId,
    reference, expectedRequestDigest: claimed.record.receipt.claim.requestDigest }, actor,
  authorization: { revision: 'policy', ruleId: 'cancel' }, requestedAtMs: 4 };
  await store.cancelInvocation(cancellation);
  if (outcome === 'responded') await store.recordResponse(claimed.record.receipt.claim, { schemaVersion: 1,
    native: { headless: { cliVersion: '2.1.fixture', builtinPlugins: settings.plugins ?? [settings.model ? `cc-${settings.model}` : 'cc-new'] } }, usage: { tokens: 7 } }, 5);
  if (outcome === 'rejected') await store.recordRejected(claimed.record.receipt.claim,
    createModelInvocationResponseEvidence(profile.adapter, 'invalid-response', null, Buffer.from('{}'), true), 5);
  if (outcome === 'unknown') await store.recordUnknown(claimed.record.receipt.claim, 'transport-error', 5);
  store.close();
  return { path, claim: claimed.record.receipt.claim };
}

it('loads one read-only receipt/control/cancellation snapshot and rejects contradictory control identity', async () => {
  const base = await fixture(), before = await readFile(base.path);
  const reader = await openSqliteModelInvocationReader(base.path, { busyTimeoutMs: 2_000 });
  const inspected = await reader.loadInspection('scope', 'invocation'); reader.close();
  expect(inspected).toMatchObject({ record: { receipt: { claim: base.claim, outcome: null }, content: null, purge: null },
    control: { claim: base.claim, reference, send: { state: 'permitted', ownerId: 'runtime-owner' },
      cancellation: { command: { commandId: 'cancel', targetCommandId: 'invoke' }, disposition: 'requested' } }, spending: null });
  expect(await readFile(base.path)).toEqual(before);
  const version = new DatabaseSync(base.path, { readOnly: true });
  expect(version.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION); version.close();

  const corrupt = new DatabaseSync(base.path);
  const row = corrupt.prepare('SELECT record FROM model_invocation_controls WHERE invocation_id=?').get('invocation') as { record: string };
  const control = JSON.parse(row.record); control.claim.invocationId = 'foreign-invocation';
  corrupt.prepare('UPDATE model_invocation_controls SET record=? WHERE invocation_id=?').run(JSON.stringify(control), 'invocation'); corrupt.close();
  const rejected = await openSqliteModelInvocationReader(base.path, { busyTimeoutMs: 2_000 });
  await expect(rejected.loadInspection('scope', 'invocation')).rejects.toThrow('MODEL_INVOCATION_CORRUPT'); rejected.close();
  const contradictory = new DatabaseSync(base.path);
  control.claim.invocationId = 'invocation'; control.send = { state: 'pending' };
  contradictory.prepare('UPDATE model_invocation_controls SET send_state=?,record=? WHERE invocation_id=?')
    .run('pending', JSON.stringify(control), 'invocation'); contradictory.close();
  const rejectedState = await openSqliteModelInvocationReader(base.path, { busyTimeoutMs: 2_000 });
  await expect(rejectedState.loadInspection('scope', 'invocation')).rejects.toThrow('MODEL_INVOCATION_CORRUPT'); rejectedState.close();
});


const observation = { schemaVersion: 1 as const, cliVersion: '2.1.fixture', builtinPlugins: { names: ['cc-new'], omitted: 2 },
  paidExtraUsage: { kind: 'overage' as const, status: 'rejected', window: 'five_hour', resetsAtMs: null } };
async function seedUsage(path: string, observationInput: unknown = observation, invocationId = 'invocation') {
  const db = new DatabaseSync(path);
  // Fixture stands for a beta.2.1-written row; production append-only guards are unchanged.
  db.exec('DROP TRIGGER IF EXISTS model_invocation_plan_usage_no_update');
  const row = db.prepare("SELECT record FROM model_invocation_plan_usage WHERE scope_id='scope' AND invocation_id=?").get(invocationId)!;
  const usage = { ...JSON.parse(String(row.record)), schemaVersion: 2, observation: observationInput };
  db.prepare("UPDATE model_invocation_plan_usage SET record=?,digest=? WHERE scope_id='scope' AND invocation_id=?").run(JSON.stringify(usage), modelInvocationPlanUsageDigest(usage), invocationId);
  db.close(); return usage;
}
const principal = (kind: 'human' | 'ai' = 'human') => kind === 'ai' ? memoryDistillerPrincipal(actor, ['scope']) : { ...actor, scopeIds: ['scope'] };
const appFor = (path: string, content: boolean, kind: 'human' | 'ai' = 'human') => new ModelInvocationInspectionApplication(verifiedPrincipal(principal(kind)),
  { async authorize(action) { if (action === 'inspect-content' && !content) throw Object.assign(new Error(), { code: 'POLICY_DENIED' }); return { revision: 'policy', ruleId: 'inspect' }; } },
  async () => openSqliteModelInvocationReader(path, { busyTimeoutMs: 2000 }));

it('reads frozen v2 facts on every settled outcome, preserves v1 bytes and rejects altered original fields or malformed observations', async () => {
  expectTypeOf<RateLimitFact>().toEqualTypeOf<ClaudeRateLimit>();
  for (const outcome of ['responded', 'rejected', 'unknown'] as const) {
    const { path } = await fixture(outcome), reader = await openSqliteModelInvocationReader(path, { busyTimeoutMs: 2000 });
    const stored = (await reader.loadInspection('scope', 'invocation'))!; reader.close();
    const v1 = createModelInvocationPlanUsage(stored.record)!;
    expect(v1.schemaVersion).toBe(1); expect(v1).not.toHaveProperty('observation');
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT record FROM model_invocation_plan_usage WHERE scope_id='scope' AND invocation_id='invocation'").get()!.record).toBe(JSON.stringify(v1)); db.close();
    for (const fact of [observation, { ...observation, builtinPlugins: null }, { ...observation, builtinPlugins: { names: [], omitted: 3 } }, null]) {
      const v2 = await seedUsage(path, fact);
      expect(verifyModelInvocationPlanUsage(v2, stored.record)).toEqual(v2);
      for (const [key, value] of Object.entries({ kind: 'wrong', scopeId: 'foreign', invocationId: 'other', profileDigest: 'b'.repeat(64),
        outcomeDigest: 'c'.repeat(64), observedAtMs: 6, source: v1.source === 'unavailable' ? 'provider-reported' : 'unavailable', counters: { wrong: 99 } })) {
        expect(() => verifyModelInvocationPlanUsage({ ...v2, [key]: value }, stored.record), key).toThrow('MODEL_INVOCATION_CORRUPT');
      }
    }
    for (const bad of [{ ...observation, builtinPlugins: null, paidExtraUsage: null },
      { ...observation, builtinPlugins: { names: Array.from({ length: 33 }, (_, i) => `p${i}`), omitted: 0 } },
      { ...observation, builtinPlugins: { names: ['bad\u0000'], omitted: 0 } }, { ...observation, cliVersion: 'x'.repeat(65) },
      { ...observation, builtinPlugins: { names: ['same', 'same'], omitted: 0 } }, { ...observation, builtinPlugins: { names: [], omitted: 0 } }]) {
      const v2 = await seedUsage(path, bad);
      await expect(appFor(path, false).inspect({ schemaVersion: 2, scopeId: 'scope', invocationId: 'invocation', reference })).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
      expect(() => verifyModelInvocationPlanUsage(v2, stored.record)).toThrow('MODEL_INVOCATION_CORRUPT');
    }
  }
});

it('projects names only with content authority, keeps paid/version facts, agrees with the result parser and leaves the digest on stored bytes', async () => {
  const { path } = await fixture('responded'), stored = await seedUsage(path), before = await readFile(path);
  for (const kind of ['human', 'ai'] as const) {
    const query = { schemaVersion: 2 as const, scopeId: 'scope', invocationId: 'invocation', reference };
    const view = await appFor(path, false, kind).inspect(query);
    expect(view.planUsage).toEqual({ ...stored, observation: { ...observation, builtinPlugins: { names: [], omitted: 3 } } });
    expect(parseModelInvocationInspectionForQuery(query, view)).toEqual(view);
    expect(JSON.stringify(view)).not.toContain('cc-new');
    await expect(appFor(path, false, kind).inspect({ ...query, includeResponseContent: true })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const fullQuery = { ...query, includeResponseContent: true }, full = await appFor(path, true, kind).inspect(fullQuery);
    expect(full.planUsage).toEqual(stored); expect(parseModelInvocationInspectionForQuery(fullQuery, full)).toEqual(full);
  }
  expect(await readFile(path)).toEqual(before);
  const db = new DatabaseSync(path); db.prepare('UPDATE model_invocation_plan_usage SET digest=?').run('f'.repeat(64)); db.close();
  await expect(appFor(path, true).inspect({ schemaVersion: 2, scopeId: 'scope', invocationId: 'invocation', reference })).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
});

it('pages doctor history with cross-record deduplication, reference-specific decisions, scope, ceiling and purge evidence without writes', async () => {
  const { path } = await fixture('responded'), limits = { pageSize: 1, maxRecords: 20 };
  await fixture('responded', { path, id: 'second' });
  await fixture('responded', { path, id: 'hidden', model: 'hidden' });
  await fixture('responded', { path, id: 'denied', model: 'denied' });
  await fixture('responded', { path, id: 'foreign', scope: 'foreign' });
  const before = await readFile(path);
  const allowed = await appFor(path, true).inspectNativePlugins('scope', limits);
  expect(allowed).toEqual({ calls: 4, hiddenCalls: 0, names: ['cc-denied', 'cc-hidden', 'cc-new'].map(name => ({ cliVersion: '2.1.fixture', name })), omitted: '0', complete: true });
  const mixed = new ModelInvocationInspectionApplication(verifiedPrincipal(principal()), { async authorize(action, target) {
    if (target.reference.modelId === 'denied' || action === 'inspect-content' && target.reference.modelId === 'hidden') throw Object.assign(new Error(), { code: 'POLICY_DENIED' });
    return { revision: 'policy', ruleId: 'inspect' };
  } }, async () => openSqliteModelInvocationReader(path, { busyTimeoutMs: 2000 }));
  expect(await mixed.inspectNativePlugins('scope', limits)).toEqual({ ...allowed, calls: 3, hiddenCalls: 1, names: [{ cliVersion: '2.1.fixture', name: 'cc-new' }] });
  expect(await appFor(path, false, 'ai').inspectNativePlugins('scope', limits)).toEqual({ calls: 4, hiddenCalls: 4, names: [], omitted: '0', complete: true });
  expect(await appFor(path, true).inspectNativePlugins('scope', { pageSize: 1, maxRecords: 1 })).toMatchObject({ complete: false });
  const other = new ModelInvocationInspectionApplication(verifiedPrincipal({ ...principal(), scopeIds: ['empty'] }),
    { async authorize() { return { revision: 'policy', ruleId: 'inspect' }; } }, async () => openSqliteModelInvocationReader(path, { busyTimeoutMs: 2000 }));
  expect(await other.inspectNativePlugins('empty', limits)).toEqual({ calls: 0, hiddenCalls: 0, names: [], omitted: '0', complete: true });
  expect(await readFile(path)).toEqual(before);
  await seedUsage(path, { ...observation, builtinPlugins: null });
  expect(await appFor(path, true).inspectNativePlugins('scope', limits)).toMatchObject({ calls: 4, complete: true });
  const store = await openSqliteModelInvocationStore(path, options, 'forbid');
  const record = (await store.loadInvocation('scope', 'invocation'))!;
  await store.purgeContent({ command: { schemaVersion: 1, commandId: 'purge', scopeId: 'scope', invocationId: 'invocation', reference,
    expectedContentDigest: record.content!.descriptor.digest }, actor, authorization: { revision: 'policy', ruleId: 'purge-content' }, purgedAtMs: 30 });
  store.close();
  const purged = await readFile(path);
  expect(await appFor(path, true).inspectNativePlugins('scope', limits)).toMatchObject({ calls: 3, complete: false });
  expect(await readFile(path)).toEqual(purged);
  await seedUsage(path);
  expect(await appFor(path, true).inspectNativePlugins('scope', limits)).toMatchObject({ calls: 4, complete: true });
  const legacyNames = ['x'.repeat(257), ...Array.from({ length: 32 }, (_, i) => `legacy-${i}`)];
  await fixture('responded', { path, id: 'legacy-many', plugins: legacyNames });
  const legacy = await appFor(path, true).inspectNativePlugins('scope', limits);
  expect(legacy).toMatchObject({ calls: 5, complete: true });
  for (const name of legacyNames) expect(legacy.names).toContainEqual({ cliVersion: '2.1.fixture', name });
  expect(await appFor(path, false).inspectNativePlugins('scope', limits)).toMatchObject({ calls: 5, hiddenCalls: 5, names: [] });
});


it('keeps the r7 total-count boundary through full/count parsing and sums doctor omissions exactly across records', async () => {
  const { path } = await fixture('responded');
  const query = { schemaVersion: 2 as const, scopeId: 'scope', invocationId: 'invocation', reference };
  await seedUsage(path, { ...observation, builtinPlugins: { names: ['overflow'], omitted: Number.MAX_SAFE_INTEGER } });
  await expect(appFor(path, false).inspect(query)).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
  const input = await seedUsage(path, { ...observation, builtinPlugins: { names: Array.from({ length: 32 }, (_, index) => `plugin-${index}`), omitted: Number.MAX_SAFE_INTEGER - 32 } });
  const reader = await openSqliteModelInvocationReader(path, { busyTimeoutMs: 2000 });
  const stored = (await reader.loadInspection('scope', 'invocation'))!; reader.close();
  expect(verifyModelInvocationPlanUsage(input, stored.record)).toEqual(input);
  const fullQuery = { ...query, includeResponseContent: true }, full = await appFor(path, true).inspect(fullQuery);
  expect(full.planUsage).toEqual(input); expect(parseModelInvocationInspectionForQuery(fullQuery, full)).toEqual(full);
  const projected = await appFor(path, false).inspect(query);
  expect(projected.planUsage).toMatchObject({ observation: { builtinPlugins: { names: [], omitted: Number.MAX_SAFE_INTEGER } } });
  expect(parseModelInvocationInspectionForQuery(query, projected)).toEqual(projected);
  for (const id of ['invocation', 'second', 'third']) {
    if (id !== 'invocation') await fixture('responded', { path, id });
    await seedUsage(path, { ...observation, builtinPlugins: { names: [], omitted: Number.MAX_SAFE_INTEGER } }, id);
  }
  const before = await readFile(path);
  expect(await appFor(path, true).inspectNativePlugins('scope', { pageSize: 1, maxRecords: 3 })).toEqual({
    calls: 3, hiddenCalls: 0, names: [], omitted: '27021597764222973', complete: true });
  expect(await appFor(path, false).inspectNativePlugins('scope', { pageSize: 1, maxRecords: 3 })).toEqual({
    calls: 3, hiddenCalls: 3, names: [], omitted: '0', complete: true });
  expect(await readFile(path)).toEqual(before);
});

it('selects the private body only for the exact responded receipt, with permission and live custody', async () => {
  const { path } = await fixture('responded', { wal: true });
  await fixture('responded', { path, id: 'absent', wal: true });
  const readerOptions = { busyTimeoutMs: options.busyTimeoutMs };
  const reader = await openSqliteModelInvocationReader(path, readerOptions);
  const { receipt, content } = (await reader.loadInvocation('scope', 'invocation'))!;
  const { receipt: absent } = (await reader.loadInvocation('scope', 'absent'))!;
  reader.close();
  const writer = new DatabaseSync(path);
  writer.prepare('DELETE FROM model_invocation_contents WHERE invocation_id=?').run(absent.claim.invocationId);
  expect(writer.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
  const realPrepare = DatabaseSync.prototype.prepare;
  const selected: string[] = [];
  const sql = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, statement) {
    const prepared = realPrepare.call(this, statement);
    if (/c\.record AS content_record/iu.test(statement)) {
      const get = prepared.get.bind(prepared);
      vi.spyOn(prepared, 'get').mockImplementation((...args: Parameters<typeof prepared.get>) => {
        selected.push(String(args[1])); return get(...args);
      });
    }
    return prepared;
  });
  const order: string[] = [];
  const app = new ModelInvocationInspectionApplication(verifiedPrincipal({ ...actor, scopeIds: ['scope', 'other'] }),
    { async authorize(action) { order.push(action); return { revision: 'policy', ruleId: 'inspect' }; } },
    async () => openSqliteModelInvocationReader(path, readerOptions));
  const person = vi.fn(async () => { order.push('person'); expect(selected).toEqual([]); });
  let connected = true, pinned = true;
  const current = () => connected && pinned;
  const refused = { code: 'MODEL_INVOCATION_UNAVAILABLE' };
  try {
    expect(receipt.outcome?.state).toBe('responded');
    if (receipt.outcome?.state !== 'responded') throw new Error('expected fixture response');
    const wrongDigest = 'b'.repeat(64);
    const otherProfile = { ...receipt.profile, scopeId: 'other' }, otherProfileDigest = modelInvocationProfileDigest(otherProfile);
    for (const wrong of [
      { ...receipt, request: { ...receipt.request, scopeId: 'other' }, profile: otherProfile, profileDigest: otherProfileDigest,
        claim: { ...receipt.claim, scopeId: 'other', profileDigest: otherProfileDigest } },
      { ...receipt, request: { ...receipt.request, requestDigest: wrongDigest }, claim: { ...receipt.claim, requestDigest: wrongDigest } },
      { ...receipt, outcome: { ...receipt.outcome, content: { ...receipt.outcome.content, digest: wrongDigest } } },
      { ...receipt, outcome: { ...receipt.outcome, content: { ...receipt.outcome.content, byteLength: 1 } } },
      absent,
    ]) await expect(app.readRetainedTurnResponse(wrong, person, current)).rejects.toMatchObject(refused);
    expect(person).not.toHaveBeenCalled();
    await expect(app.readRetainedTurnResponse(receipt, async () => { throw Object.assign(new Error(), { code: 'POLICY_DENIED' }); }, current))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    let policyAllowed = true;
    await expect(app.readRetainedTurnResponse(receipt, async () => {
      const policyCheck = Promise.resolve().then(() => policyAllowed);
      policyAllowed = false;
      if (!await policyCheck) throw Object.assign(new Error(), { code: 'POLICY_DENIED' });
    }, current)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(app.readRetainedTurnResponse(receipt, async () => { await person(); connected = false; }, current)).rejects.toMatchObject(refused);
    connected = true;
    await expect(app.readRetainedTurnResponse(receipt, async () => { await person(); pinned = false; }, current)).rejects.toMatchObject(refused);
    pinned = true;
    expect(selected).toEqual([]);
    order.length = 0;
    expect(await app.readRetainedTurnResponse(receipt, person, current)).toMatchObject({ receipt, response: (content as { response: unknown }).response });
    expect(order).toEqual(['inspect', 'person']); expect(selected.splice(0)).toEqual(['invocation']);

    // Corruption keeps the matching metadata but never delivers the selected body.
    writer.prepare("UPDATE model_invocation_contents SET record=json_set(record,'$.response.native.headless.cliVersion','modified') WHERE invocation_id=?")
      .run('invocation');
    await expect(app.readRetainedTurnResponse(receipt, person, current)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CORRUPT' });
    expect(selected.splice(0)).toEqual(['invocation']);

    // Commit a purge via a second WAL connection while the asynchronous permission gate is open.
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare('INSERT INTO model_invocation_content_purges(scope_id,command_id,invocation_id,record) VALUES(?,?,?,?)').run('scope', 'purge', 'invocation', '{}');
    writer.prepare('UPDATE model_invocation_contents SET record=NULL,purge_command_id=? WHERE invocation_id=?').run('purge', 'invocation');
    await expect(app.readRetainedTurnResponse(receipt, async () => { await person(); writer.exec('COMMIT'); }, current)).rejects.toMatchObject(refused);
    expect(selected).toEqual([]);
  } finally { sql.mockRestore(); writer.close(); }
});
