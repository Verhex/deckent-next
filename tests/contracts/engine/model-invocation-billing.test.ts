import { upgradeExistingLedger, CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { DOWNGRADE_TO_V54_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
import { encodeModelBindingDefinition, type ModelInvocationBillingAxis, type ModelInvocationProfile, type ModelInvocationNativeResponse } from '#domain/index.js';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore, openSqliteModelInvocationReader } from '#adapters/index.js';
import { ModelInvocationApplication, ModelInvocationInspectionApplication, ModelInvocationPurgeApplication, ModelBindingApplication,
  modelInvocationProfileDigest, modelInvocationPlanUsageDigest, modelInvocationRequestDigest, providerSpendEvidenceDigest, classifyWorkSpending, createProviderSpendCheckpoint,
  parseModelInvocationInspectionForQuery, type ModelInvocationSpendingAuthority, type ModelInvocationSpendingInput } from '#engine/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 1000 };
const reference = { providerId: 'fixture-provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const model = { id: 'model', version: 1, nativeId: 'fixture-native', protocols: [{ family: 'fixture-protocol', version: '1', capabilities: [] }] };
const catalog = { schemaVersion: 1 as const, revision: 'catalog', providers: [{ id: reference.providerId, version: 1, models: [model] }] };
const definition = { encodingVersion: 1 as const, provider: { id: reference.providerId, version: 1 }, model };
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const principal = { id: 'actor', issuer: 'os', subject: '1', assurance: 'os-user' as const, scopeIds: ['scope'] };
const verifier = { async verify() { return principal; } };

async function fixture(axis: ModelInvocationBillingAxis | 'v1' = 'subscription', limit = 0) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-billing-')); roots.push(root);
  const path = join(root, 'ledger.db');
  const profileBase = { id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'fixture-protocol', version: '1' }, adapter: { id: 'fixture-adapter', version: 1,
      definition: { endpoint: 'http://127.0.0.1:1/model', tariff: { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } } },
    allocation: { id: 'allocation', maxCalls: 10, maxInFlight: 1 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  let profile: ModelInvocationProfile = axis === 'v1' ? { schemaVersion: 1, ...profileBase } : { schemaVersion: 2, billingAxis: axis, ...profileBase };
  const store = await openSqliteModelActivationStore(path, sqlite);
  await store.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, definition,
    actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance }, authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1 });
  store.close();
  let cancelBeforeSend = false;
  let allowed = true, supported = axis === 'subscription', failed = false, sequence = 0;
  let response: ModelInvocationNativeResponse = { schemaVersion: 1, native: { text: 'ok' }, usage: { input_tokens: 5, output_tokens: 3, total_cost_usd: 100, nested: { cached_tokens: 2 }, note: 'not a counter' } };
  const authorization = { async authorize() { if (!allowed) throw new Error('DENIED'); return { revision: 'policy', ruleId: 'invoke' }; } };
  const quote = (input: ModelInvocationSpendingInput) => {
    const pricing = axis === 'local' ? profileBase.adapter.definition.tariff : { schemaVersion: 1, kind: 'synthetic-price' };
    const evidence = { schemaVersion: 1, kind: 'synthetic-meter' };
    return { schemaVersion: 1 as const, scopeId: 'scope', requestDigest: input.requestDigest, profileDigest: input.profileDigest,
      pricing: { id: 'fixture-price', version: 1, digest: providerSpendEvidenceDigest(pricing), definition: pricing },
      meter: { id: 'fixture-meter', version: 1, evidenceDigest: providerSpendEvidenceDigest(evidence), evidence }, currency: 'USD', maxChargeMinorUnits: axis === 'local' ? 0 : 6 };
  };
  const authority: ModelInvocationSpendingAuthority = { authorize: vi.fn(async input => ({ budget: axis === 'local' ? null : { schemaVersion: 1 as const,
    scopeId: 'scope', budgetId: 'scope-budget', revision: 1, currency: 'USD', limitMinorUnits: limit }, quote: quote(input) })), checkCapacity: vi.fn() };
  const native = { prepare: vi.fn(async () => ({})), send: vi.fn(async () => { if (failed) throw new Error('DISCONNECTED'); return response; }) };
  const app = () => new ModelInvocationApplication(verifier, authorization, new ModelBindingApplication({ async read() { return catalog; } }),
    async () => { const reader = await openSqliteModelActivationStore(path, sqlite, 'forbid'); return reader; },
    { async resolve() { return profile; } }, { resolve() { return { ...native, ...(supported ? { billingAxis: 'subscription' as const } : {}) }; } },
    async () => {
      const writer = await openSqliteModelInvocationStore(path, sqlite, 'forbid');
      if (cancelBeforeSend) { const permit = writer.permitSend.bind(writer); writer.permitSend = async (claim, owner, now) => {
        await writer.cancelInvocation({ command: { schemaVersion: 1, commandId: 'cancel', scopeId: claim.scopeId, targetCommandId: claim.commandId,
          reference, expectedRequestDigest: claim.requestDigest }, actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance },
          authorization: { revision: 'policy', ruleId: 'cancel' }, requestedAtMs: now });
        return permit(claim, owner, now);
      }; }
      return writer;
    }, { invocationId: () => `invocation-${++sequence}`, ownerId: () => 'test-owner', now: () => 20 }, authority);
  const command = (commandId = 'command') => ({ schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: {} });
  const inspect = (invocationId: string, content = false) => new ModelInvocationInspectionApplication(verifier, authorization,
    async () => openSqliteModelInvocationReader(path, { busyTimeoutMs: 1000 })).inspect({ schemaVersion: 2, scopeId: 'scope', reference, invocationId, ...(content ? { includeResponseContent: true } : {}) });
  const counts = () => { const db = new DatabaseSync(path); try { return ['provider_spend_accounts', 'model_invocation_spend_reservations', 'model_invocation_plan_usage', 'model_invocations']
    .map(table => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)); } finally { db.close(); } };
  return { path, root, profile, app, command, inspect, counts, authority, native, deny() { allowed = false; }, unsupport() { supported = false; }, support() { supported = true; },
    switchAxis(billingAxis: ModelInvocationBillingAxis) { profile = { ...profileBase, schemaVersion: 2, billingAxis }; },
    remote() { profile = { ...profile, adapter: { ...profile.adapter, definition: { ...profile.adapter.definition, endpoint: 'https://fixture.invalid/model' } } }; }, noUsage() { response = { ...response, usage: null }; }, fail() { failed = true; },
    cancelBeforeSend() { cancelBeforeSend = true; },
    purge: (invocationId: string, digest: string) => new ModelInvocationPurgeApplication(verifier, authorization,
      async () => openSqliteModelInvocationStore(path, sqlite, 'forbid'), { now: () => 30 }).purge({ schemaVersion: 1, commandId: 'purge', scopeId: 'scope', invocationId, reference, expectedContentDigest: digest }) };
}

it('admits subscription at zero budget, records only provider counters atomically and replays without charging or sending again', async () => {
  const f = await fixture();
  await f.app().preview(f.command());
  expect(f.authority.authorize).not.toHaveBeenCalled(); expect(f.authority.checkCapacity).not.toHaveBeenCalled();
  expect(f.counts()).toEqual([0, 0, 0, 0]);
  const first = await f.app().invoke(f.command());
  expect(first.receipt.profile).toMatchObject({ schemaVersion: 2, billingAxis: 'subscription' });
  const view = await f.inspect(first.receipt.claim.invocationId, true);
  expect(view.planUsage).toMatchObject({ schemaVersion: 1, kind: 'plan-usage', counters: { input_tokens: 5, output_tokens: 3, nested: { cached_tokens: 2 } } });
  expect(view.planUsage?.counters).not.toHaveProperty('total_cost_usd'); expect(view.planUsage).not.toHaveProperty('currency');
  expect(view.spending).toBeNull(); expect(f.counts()).toEqual([0, 0, 1, 1]);
  expect(parseModelInvocationInspectionForQuery({ schemaVersion: 2, scopeId: 'scope', reference, invocationId: first.receipt.claim.invocationId, includeResponseContent: true }, view)).toEqual(view);
  f.switchAxis('metered');
  expect((await f.app().invoke(f.command())).receipt).toEqual(first.receipt); expect(f.native.send).toHaveBeenCalledTimes(1);
  expect(f.counts()).toEqual([0, 0, 1, 1]);
});
it('retains unknown usage as null and never invents a zero charge', async () => {
  const f = await fixture(); f.noUsage(); const result = await f.app().invoke(f.command());
  expect((await f.inspect(result.receipt.claim.invocationId)).planUsage?.counters).toBeNull(); expect(f.counts()).toEqual([0, 0, 1, 1]);
});
it('settles a lost subscription response as unknown with no money hold and no resend', async () => {
  const f = await fixture(); f.fail(); const result = await f.app().invoke(f.command());
  expect(result.receipt.outcome?.state).toBe('unknown');
  expect((await f.inspect(result.receipt.claim.invocationId)).planUsage?.counters).toBeNull();
  expect((await f.app().invoke(f.command())).replayed).toBe(true); expect(f.native.send).toHaveBeenCalledTimes(1);
});
it('rejects metered work at zero money before send and preserves its reservation path with a budget', async () => {
  const zero = await fixture('metered'); await expect(zero.app().invoke(zero.command())).rejects.toMatchObject({ code: 'PROVIDER_SPEND_EXHAUSTED' });
  expect(zero.native.send).not.toHaveBeenCalled(); expect(zero.counts()).toEqual([0, 0, 0, 0]);
  const paid = await fixture('metered', 10); const result = await paid.app().invoke(paid.command());
  expect((await paid.inspect(result.receipt.claim.invocationId)).spending?.disposition.state).toBe('held'); expect(paid.counts()).toEqual([1, 1, 0, 1]);
});
it('keeps local zero-tariff calls budgetless and outside plan usage', async () => {
  const f = await fixture('local'); const result = await f.app().invoke(f.command());
  expect(classifyWorkSpending({ kind: 'model', profile: f.profile })).toBe('not-metered');
  expect((await f.inspect(result.receipt.claim.invocationId)).planUsage).toBeNull(); expect(f.counts()).toEqual([0, 0, 0, 1]);
});
it('requires subscription support from the native port and never falls back to a paid transport', async () => {
  const f = await fixture(); f.unsupport();
  await expect(f.app().preview(f.command())).rejects.toMatchObject({ code: 'MODEL_INVOCATION_PROFILE_CONFLICT' });
  await expect(f.app().invoke(f.command())).rejects.toMatchObject({ code: 'MODEL_INVOCATION_PROFILE_CONFLICT' });
  expect(f.native.prepare).not.toHaveBeenCalled(); expect(f.native.send).not.toHaveBeenCalled(); expect(f.counts()).toEqual([0, 0, 0, 0]);
});
it('refuses a subscription transport relabelled metered and preserves policy denial', async () => {
  const f = await fixture(); f.switchAxis('metered');
  await expect(f.app().invoke(f.command())).rejects.toMatchObject({ code: 'MODEL_INVOCATION_PROFILE_CONFLICT' });
  f.switchAxis('subscription'); f.deny(); await expect(f.app().invoke(f.command())).rejects.toThrow('DENIED');
  expect(f.native.send).not.toHaveBeenCalled(); expect(f.counts()).toEqual([0, 0, 0, 0]);
});
it('retains plan counters after governed purge and detects corrupted usage rows', async () => {
  const f = await fixture(); const result = await f.app().invoke(f.command());
  const before = await f.inspect(result.receipt.claim.invocationId); await f.purge(result.receipt.claim.invocationId, result.receipt.outcome!.content!.digest);
  const after = await f.inspect(result.receipt.claim.invocationId); expect(after.planUsage).toEqual(before.planUsage); expect(after.contentStatus).toBe('purged');
  const db = new DatabaseSync(f.path);
  try {
    expect(() => db.exec('UPDATE model_invocation_plan_usage SET digest=digest')).toThrow('PLAN_USAGE_APPEND_ONLY');
    db.exec('DROP TRIGGER model_invocation_plan_usage_no_update');
    db.exec("UPDATE model_invocation_plan_usage SET digest='invalid'");
  } finally { db.close(); }
  await expect(f.inspect(result.receipt.claim.invocationId)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CORRUPT' });
});
it('binds plan evidence to the exact outcome and rejects forged counters even with a recalculated row hash', async () => {
  const f = await fixture(); const result = await f.app().invoke(f.command()); const view = await f.inspect(result.receipt.claim.invocationId);
  const db = new DatabaseSync(f.path);
  try {
    const forged = { ...view.planUsage!, counters: { input_tokens: 9000 } };
    db.exec('DROP TRIGGER model_invocation_plan_usage_no_update');
    db.prepare('UPDATE model_invocation_plan_usage SET record=?,digest=?').run(JSON.stringify(forged), modelInvocationPlanUsageDigest(forged));
  } finally { db.close(); }
  await expect(f.inspect(result.receipt.claim.invocationId)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CORRUPT' });
});
it('upgrades a copied populated v54 ledger, preserves stored v1 receipt bytes and replay, and restores its backup', async () => {
  const f = await fixture('v1', 10), first = await f.app().invoke(f.command());
  const original = new DatabaseSync(f.path); const records = original.prepare('SELECT record FROM model_invocations').all();
  original.exec(DOWNGRADE_TO_V54_LEDGER_SQL); original.close();
  const candidate = join(f.root, 'candidate.db'); await copyFile(f.path, candidate);
  const upgraded = upgradeExistingLedger(candidate, sqlite, f.root, new Date(1000));
  expect(upgraded).toMatchObject({ from: 54, to: CURRENT_LEDGER_VERSION });
  const db = new DatabaseSync(candidate); expect(db.prepare('SELECT record FROM model_invocations').all()).toEqual(records);
  expect(db.prepare('SELECT count(*) AS n FROM model_invocation_plan_usage').get()!.n).toBe(0);
  expect(db.prepare('SELECT count(*) AS n FROM audit_checkpoints').get()!.n).toBe(0); db.close();
  const reader = await openSqliteModelInvocationReader(candidate, { busyTimeoutMs: 1000 });
  try { expect((await reader.loadReceipt('scope', 'command'))?.receipt).toEqual(first.receipt); } finally { reader.close(); }
  const writer = await openSqliteModelInvocationStore(candidate, sqlite, 'forbid');
  try {
    const kept = await writer.loadReceipt('scope', 'command'); expect(kept?.receipt.profileDigest).toBe(modelInvocationProfileDigest(f.profile));
    expect(kept?.receipt.request.requestDigest).toBe(modelInvocationRequestDigest(f.command()));
  } finally { writer.close(); }
  await copyFile(candidate, f.path);
  expect((await f.app().invoke(f.command())).receipt).toEqual(first.receipt); expect(f.native.send).toHaveBeenCalledTimes(1);
  const restored = join(f.root, 'restored.db'); await copyFile(upgraded!.backupPath, restored);
  const down = new DatabaseSync(restored); try { expect(down.prepare('PRAGMA user_version').get()!.user_version).toBe(54); expect(down.prepare('SELECT record FROM model_invocations').all()).toEqual(records); } finally { down.close(); }
});

it('prevents a cancelled subscription send and records a counterless plan settlement in the same transaction', async () => {
  const f = await fixture(); f.cancelBeforeSend(); const result = await f.app().invoke(f.command());
  expect(result.receipt.outcome?.state).toBe('not-sent'); expect(f.native.send).not.toHaveBeenCalled();
  expect((await f.inspect(result.receipt.claim.invocationId)).planUsage?.counters).toBeNull(); expect(f.counts()).toEqual([0, 0, 1, 1]);
});

it('does not waive a remote or unverified local tariff through the local label', async () => {
  const f = await fixture('local'); f.remote();
  await expect(f.app().invoke(f.command())).rejects.toMatchObject({ code: 'PROVIDER_SPEND_CONFLICT' });
  expect(f.native.send).not.toHaveBeenCalled(); expect(f.counts()).toEqual([0, 0, 0, 0]);
});
it('does not let a frozen money account block a subscription call or change retained paid holds', async () => {
  const f = await fixture('metered', 10); await f.app().invoke(f.command('paid'));
  const db = new DatabaseSync(f.path); let paidBefore;
  try {
    const row = db.prepare('SELECT * FROM provider_spend_accounts').get()!;
    const checkpoint = createProviderSpendCheckpoint({ ...JSON.parse(String(row.record)), frozen: true }, Number(row.revision) + 1, Number(row.reservation_count));
    db.prepare('UPDATE provider_spend_accounts SET record=?,revision=?,digest=?').run(JSON.stringify(checkpoint.account), checkpoint.revision, checkpoint.digest);
    paidBefore = { account: db.prepare('SELECT * FROM provider_spend_accounts').all(), holds: db.prepare('SELECT * FROM model_invocation_spend_reservations').all() };
  } finally { db.close(); }
  f.switchAxis('subscription'); f.support(); await f.app().preview(f.command('plan')); const result = await f.app().invoke(f.command('plan'));
  expect((await f.inspect(result.receipt.claim.invocationId)).planUsage?.kind).toBe('plan-usage');
  const after = new DatabaseSync(f.path); try {
    expect({ account: after.prepare('SELECT * FROM provider_spend_accounts').all(), holds: after.prepare('SELECT * FROM model_invocation_spend_reservations').all() }).toEqual(paidBefore);
  } finally { after.close(); }
});
it('rolls back outcome, usage and slot release together on usage write failure, then recovers unknown through the same transition', async () => {
  const f = await fixture(), db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER usage_failure BEFORE INSERT ON model_invocation_plan_usage BEGIN SELECT RAISE(ABORT,'INJECTED_USAGE_FAILURE'); END;"); db.close();
  await expect(f.app().invoke(f.command())).rejects.toMatchObject({ code: 'MODEL_INVOCATION_OUTCOME_UNKNOWN' });
  const pending = await f.inspect('invocation-1'); expect(pending.invocation?.outcome).toBeNull(); expect(pending.planUsage).toBeNull();
  const recovery = new DatabaseSync(f.path); expect(recovery.prepare('SELECT in_flight FROM model_invocation_allocations').get()!.in_flight).toBe(1);
  recovery.exec('DROP TRIGGER usage_failure'); recovery.close();
  const writer = await openSqliteModelInvocationStore(f.path, sqlite, 'forbid');
  try { expect(await writer.releaseSettledSlots({ atMs: 40, endedOwner: owner => owner === 'test-owner' })).toMatchObject({ settled: 1 }); }
  finally { writer.close(); }
  const final = await f.inspect('invocation-1'); expect(final.invocation?.outcome?.state).toBe('unknown'); expect(final.planUsage?.counters).toBeNull();
  expect(f.native.send).toHaveBeenCalledTimes(1); expect(f.counts()).toEqual([0, 0, 1, 1]);
});
