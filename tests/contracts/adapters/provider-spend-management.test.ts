import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore, openSqliteProviderSpendManagementStore, openSqliteProviderSpendIntegrityReader, upgradeExistingProductLedger } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { createModelInvocationResponseEvidence, ProviderSpendManagementApplication, parseProviderSpendCheckpoint, verifyProviderSpendIntegrity, providerSpendReservationDigest, modelInvocationProfileDigest, modelInvocationRequestDigest, modelInvocationResponseContentDescriptor,
  providerSpendQuoteDigest, type ProviderSpendTariffMeasurement } from '#engine/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'provider', version: 1,
  models: [{ id: 'model', version: 1, nativeId: 'native/model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] }] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;


async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-reported-spend-')); roots.push(root); const path = join(root, 'ledger.db');
  const activations = await openSqliteModelActivationStore(path, options);
  const activation = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  activations.close(); return { path, activation: activation.receipt.record };
}
function admission(base: Awaited<ReturnType<typeof fixture>>, suffix: string, spending = true) {
  const command = { schemaVersion: 1 as const, commandId: `command-${suffix}`, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: suffix }] } };
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'fixture', version: 1, definition: {} },
    allocation: { id: 'allocation', maxCalls: 10, maxInFlight: 10 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  const requestDigest = modelInvocationRequestDigest(command), profileDigest = modelInvocationProfileDigest(profile);
  const quote = { schemaVersion: 1 as const, scopeId: 'scope', requestDigest, profileDigest,
    pricing: { id: 'price', version: 1, digest: '291f395a66cb728f57612b09b06f9512815b982e9a5d65e3fafec28256ff0aa9', definition: { schemaVersion: 1, kind: 'synthetic-price' } },
    meter: { id: 'meter', version: 1, evidenceDigest: '446658cc1c39184b672f423a7f970bffab0e8f38e851c5b5dacd3f38eb85051f', evidence: { schemaVersion: 1, kind: 'synthetic-meter' } },
    currency: 'USD', maxChargeMinorUnits: 6 };
  return { input: { command, requestDigest, actor, authorization: { revision: 'policy', ruleId: 'invoke' }, definition,
    activation: base.activation, profile, profileDigest, invocationId: `invocation-${suffix}`, claimedAtMs: 2,
    ...(spending ? { spending: { budget: { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 20 }, quote } } : {}) }, quote };
}
const response = { schemaVersion: 1 as const, native: { answer: 'ok' }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
function checkpoint(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM provider_spend_accounts WHERE scope_id=?').get('scope')!;
    return parseProviderSpendCheckpoint({ schemaVersion: 2, revision: row.revision, reservationCount: row.reservation_count,
      account: JSON.parse(row.record as string), digest: row.digest });
  } finally { db.close(); }
}
const principal = { ...actor, scopeIds: ['scope'] };
function application(path: string, allowed = true) {
  return new ProviderSpendManagementApplication({ async verify() { return principal; } },
    { async authorize() { if (!allowed) throw new Error('POLICY_DENIED'); return { revision: 'policy', ruleId: 'spend-management' }; } },
    async () => openSqliteProviderSpendManagementStore(path, options), () => 50);
}
async function heldFixture(overrun = false) {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const f = admission(base, 'one'), claim = await store.claim(f.input);
  await store.permitSend(claim.record.receipt.claim, 'owner', 3);
  if (overrun) {
    const measurement: ProviderSpendTariffMeasurement = { schemaVersion: 1, basis: 'measured-tariff', currency: 'USD',
      exactMinorUnits: '7', roundedMinorUnits: 7, quoteDigest: providerSpendQuoteDigest(f.quote), requestDigest: f.quote.requestDigest,
      profileDigest: f.quote.profileDigest, responseContentDigest: modelInvocationResponseContentDescriptor(response).digest,
      source: { id: 'test-tariff', version: 1, modelId: 'native/model', tariffDigest: f.quote.pricing.digest, tier: null, cacheSplit: 'none',
        dimensions: [{ field: 'input', tokens: 1_000_000, usdPerMillionTokens: '0.07' }] } };
    await store.recordResponse(claim.record.receipt.claim, response, 5, measurement);
  } else await store.recordUnknown(claim.record.receipt.claim, 'transport-error', 5);
  store.close(); return { ...base, invocationId: f.input.invocationId };
}
function reconcile(f: Awaited<ReturnType<typeof heldFixture>>, resolution: 'settle' | 'release' | 'write-off') {
  return { schemaVersion: 1 as const, kind: 'reconcile' as const, scopeId: 'scope', budgetId: 'budget', budgetRevision: 1,
    commandId: `reconcile-${resolution}`, expectedCheckpointDigest: checkpoint(f.path).digest, invocationId: f.invocationId,
    resolution, exactMinorUnits: resolution === 'settle' ? '0.25' : '0',
    evidence: { kind: resolution === 'write-off' ? 'write-off' as const : 'console-figure' as const, digest: 'a'.repeat(64) } };
}
it.each(['settle', 'release', 'write-off'] as const)('governs %s with immutable audit, releases capacity, and permits exact replay', async resolution => {
  const f = await heldFixture(), command = reconcile(f, resolution), app = application(f.path);
  const result = await app.execute(command);
  expect(result).toMatchObject({ replayed: false, receipt: { actor, authorization: { ruleId: 'spend-management' }, command } });
  expect(checkpoint(f.path).account).toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: command.exactMinorUnits });
  expect(await app.execute(command)).toMatchObject({ replayed: true, receipt: result.receipt });
  await expect(app.execute({ ...command, commandId: 'other', expectedCheckpointDigest: checkpoint(f.path).digest })).rejects.toThrow('PROVIDER_SPEND_CONFLICT');
  const reader = await openSqliteProviderSpendIntegrityReader(f.path, { busyTimeoutMs: 20 });
  try { expect(await verifyProviderSpendIntegrity(reader, 'scope', 2)).toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: command.exactMinorUnits }); } finally { reader.close(); }
  const db = new DatabaseSync(f.path);
  try {
    expect(() => db.exec('DELETE FROM provider_spend_management')).toThrow('PROVIDER_SPEND_APPEND_ONLY');
    expect(() => db.exec("UPDATE provider_spend_management SET record='{}'")).toThrow('PROVIDER_SPEND_APPEND_ONLY');
  } finally { db.close(); }
});
it('refuses unauthorized corrections without changing money or recording an audit', async () => {
  const f = await heldFixture(), before = checkpoint(f.path);
  await expect(application(f.path, false).execute(reconcile(f, 'release'))).rejects.toThrow('POLICY_DENIED');
  expect(checkpoint(f.path)).toEqual(before);
});
it('revises budgets upward and below outstanding spending, then explicitly unfreezes without rewriting the overrun', async () => {
  const f = await heldFixture(true), app = application(f.path), original = new DatabaseSync(f.path, { readOnly: true });
  const record = original.prepare('SELECT record FROM model_invocation_spend_reservations').get()!.record; original.close();
  for (const [limit, unfreeze] of [[100, false], [2, true], [200, false]] as const) {
    const current = checkpoint(f.path), budget = { ...current.account.budget, revision: current.account.budget.revision + 1, limitMinorUnits: limit };
    const result = await app.execute({ schemaVersion: 1, kind: 'budget-revision', commandId: `revision-${budget.revision}`, scopeId: 'scope',
      budgetId: 'budget', budgetRevision: current.account.budget.revision, expectedCheckpointDigest: current.digest,
      budget, unfreeze, evidenceDigest: 'a'.repeat(64) });
    expect(result.receipt.after.budget).toEqual(budget);
    if (unfreeze) expect(result.receipt.after.frozen).toBe(false);
    const reader = await openSqliteProviderSpendIntegrityReader(f.path, { busyTimeoutMs: 20 });
    try { await verifyProviderSpendIntegrity(reader, 'scope', 2); } finally { reader.close(); }
  }
  const db = new DatabaseSync(f.path, { readOnly: true });
  try { expect(db.prepare('SELECT record FROM model_invocation_spend_reservations').get()!.record).toBe(record); } finally { db.close(); }
});
it('settles partial provider usage with an unknown cancelled outcome, while absent usage remains held', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  for (const hasUsage of [false, true]) {
    const f = admission(base, hasUsage ? 'usage' : 'missing'), claimed = await store.claim(f.input), claim = claimed.record.receipt.claim;
    await store.permitSend(claim, 'owner', 3);
    const evidence = createModelInvocationResponseEvidence({ id: 'fixture', version: 1 }, 'interrupted', 200, Buffer.from('partial'), false, 7);
    const measurement: ProviderSpendTariffMeasurement | null = hasUsage ? { schemaVersion: 1, basis: 'measured-tariff', currency: 'USD',
      exactMinorUnits: '0.001', roundedMinorUnits: 1, quoteDigest: providerSpendQuoteDigest(f.quote), requestDigest: f.quote.requestDigest,
      profileDigest: f.quote.profileDigest, responseContentDigest: evidence.body.digest,
      source: { id: 'test-tariff', version: 1, modelId: 'native/model', tariffDigest: f.quote.pricing.digest, tier: null, cacheSplit: 'none',
        dimensions: [{ field: 'input', tokens: 10, usdPerMillionTokens: '1' }] } } : null;
    const record = await store.recordUnknown(claim, 'transport-error', 5, evidence, measurement);
    expect(record.receipt.outcome?.state).toBe('unknown');
  }
  store.close();
  expect(checkpoint(base.path).account).toMatchObject({ reservedMinorUnits: 6, settledExactMinorUnits: '0.001' });
});
it('migrates an actual ledger48 reservation forward with a private v48 backup', async () => {
  const f = await heldFixture(), db = new DatabaseSync(f.path), row = db.prepare('SELECT * FROM model_invocation_spend_reservations').get()!;
  const old = { ...JSON.parse(row.record as string), schemaVersion: 2 };
  db.prepare('UPDATE model_invocation_spend_reservations SET record=?,digest=?').run(JSON.stringify(old), providerSpendReservationDigest(old));
  db.exec('DROP TRIGGER provider_spend_management_no_update; DROP TRIGGER provider_spend_management_no_delete; DROP TABLE provider_spend_management; PRAGMA user_version=48'); db.close();
  const backups = join(f.path, '..', 'backups'); await mkdir(backups);
  const upgrade = await upgradeExistingProductLedger(f.path, options, backups, new Date('2026-10-08T00:00:00Z'));
  expect(upgrade).toMatchObject({ from: 48, to: 49 });
  const backup = new DatabaseSync(upgrade!.backupPath, { readOnly: true });
  try { expect(JSON.parse(backup.prepare('SELECT record FROM model_invocation_spend_reservations').get()!.record as string).schemaVersion).toBe(2); } finally { backup.close(); }
  const current = new DatabaseSync(f.path, { readOnly: true });
  try { expect(JSON.parse(current.prepare('SELECT record FROM model_invocation_spend_reservations').get()!.record as string).schemaVersion).toBe(3); } finally { current.close(); }
});
it('cannot reconcile a settled charge; the exact original record and total remain unchanged', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid'), f = admission(base, 'settled');
  const claim = (await store.claim(f.input)).record.receipt.claim; await store.permitSend(claim, 'owner', 3);
  const measurement: ProviderSpendTariffMeasurement = { schemaVersion: 1, basis: 'measured-tariff', currency: 'USD', exactMinorUnits: '1', roundedMinorUnits: 1,
    quoteDigest: providerSpendQuoteDigest(f.quote), requestDigest: f.quote.requestDigest, profileDigest: f.quote.profileDigest,
    responseContentDigest: modelInvocationResponseContentDescriptor(response).digest,
    source: { id: 'test-tariff', version: 1, modelId: 'native/model', tariffDigest: f.quote.pricing.digest, tier: null, cacheSplit: 'none',
      dimensions: [{ field: 'input', tokens: 10_000, usdPerMillionTokens: '1' }] } };
  await store.recordResponse(claim, response, 5, measurement); store.close();
  const before = checkpoint(base.path), f2 = { ...base, invocationId: f.input.invocationId };
  await expect(application(base.path).execute(reconcile(f2, 'release'))).rejects.toThrow('PROVIDER_SPEND_CONFLICT');
  expect(checkpoint(base.path)).toEqual(before);
});

it('rolls back a correction before any money or audit mutation when delivery capacity is insufficient', async () => {
  const f = await heldFixture(), before = checkpoint(f.path);
  await expect(application(f.path).execute(reconcile(f, 'release'), undefined, 1)).rejects.toThrow('PROVIDER_SPEND_RESULT_LIMIT');
  expect(checkpoint(f.path)).toEqual(before);
  const db = new DatabaseSync(f.path, { readOnly: true });
  try { expect(db.prepare('SELECT count(*) AS n FROM provider_spend_management').get()!.n).toBe(0); } finally { db.close(); }
});
it('records a console correction over the budget, freezes new spending and still proves exact totals', async () => {
  const f = await heldFixture(), command = { ...reconcile(f, 'settle'), exactMinorUnits: '25.1' };
  await application(f.path).execute(command);
  expect(checkpoint(f.path).account).toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: '25.1', frozen: true });
  const reader = await openSqliteProviderSpendIntegrityReader(f.path, { busyTimeoutMs: 20 });
  try { expect(await verifyProviderSpendIntegrity(reader, 'scope', 2)).toMatchObject({ settledExactMinorUnits: '25.1' }); } finally { reader.close(); }
});
