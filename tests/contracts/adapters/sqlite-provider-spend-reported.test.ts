import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, modelInvocationResponseContentDescriptor,
  providerSpendQuoteDigest, type ProviderSpendReportedMeasurement } from '#engine/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'provider', version: 1,
  models: [{ id: 'model', version: 1, nativeId: 'native/model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] }] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;
const hex = (value: string) => createHash('sha256').update(value).digest('hex');

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
function measurement(input: ReturnType<typeof admission>, response: { schemaVersion: 1; native: object; usage: null }): ProviderSpendReportedMeasurement {
  return { schemaVersion: 1, basis: 'provider-reported', currency: 'USD', exactMinorUnits: '0.4', roundedMinorUnits: 1,
    quoteDigest: providerSpendQuoteDigest(input.quote), requestDigest: input.input.requestDigest, profileDigest: input.input.profileDigest,
    responseContentDigest: modelInvocationResponseContentDescriptor(response).digest,
    source: { id: 'fixture', version: 1, field: 'usage.cost', generationId: 'generation', modelId: 'native/model', numericSource: '0.004',
      minorUnitsPerCurrencyUnit: 100, bodyDigest: hex('body'), responseDigest: hex('response'), requestBodyDigest: hex('request'),
      tariffDigest: input.quote.pricing.digest, selectedEndpointTag: 'fixture' } };
}
function account(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return JSON.parse(String((db.prepare('SELECT record FROM provider_spend_accounts').get() as { record: string }).record)); }
  finally { db.close(); }
}
function settlementSnapshot(db: DatabaseSync) {
  return Object.fromEntries(['model_invocations', 'model_invocation_contents', 'model_invocation_allocations',
    'provider_spend_accounts', 'model_invocation_spend_reservations'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

it('atomically accumulates exact provider charges before taking the account ceiling', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  for (const suffix of ['one', 'two']) {
    const admitted = admission(base, suffix), claim = await store.claim(admitted.input), response = { schemaVersion: 1 as const, native: { id: suffix }, usage: null };
    await store.permitSend(claim.record.receipt.claim, 'owner', 3);
    await store.recordResponse(claim.record.receipt.claim, response, 4, measurement(admitted, response));
  }
  store.close();
  expect(account(base.path)).toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: '0.8', settledMinorUnits: 1 });
});

it('rejects mismatched or repeated measurement evidence without a second debit', async () => {
  const base = await fixture(), admitted = admission(base, 'one'), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const claim = await store.claim(admitted.input), response = { schemaVersion: 1 as const, native: { id: 'one' }, usage: null };
  await store.permitSend(claim.record.receipt.claim, 'owner', 3); const evidence = measurement(admitted, response);
  const settled = await store.recordResponse(claim.record.receipt.claim, response, 4, evidence);
  expect(await store.recordResponse(claim.record.receipt.claim, response, 4, evidence)).toEqual(settled);
  const before = account(base.path);
  await expect(store.recordResponse(claim.record.receipt.claim, response, 4,
    { ...evidence, source: { ...evidence.source, responseDigest: hex('different') } })).rejects.toThrow('PROVIDER_SPEND_CONFLICT');
  expect(account(base.path)).toEqual(before); store.close();
});

it('rolls response, allocation, account and reservation back when reported settlement cannot persist', async () => {
  const base = await fixture(), admitted = admission(base, 'one'), seed = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const claim = await seed.claim(admitted.input), response = { schemaVersion: 1 as const, native: { id: 'one' }, usage: null };
  await seed.permitSend(claim.record.receipt.claim, 'owner', 3); seed.close();
  const db = new DatabaseSync(base.path), before = settlementSnapshot(db);
  db.exec(`CREATE TRIGGER reject_reported BEFORE UPDATE ON model_invocation_spend_reservations
    BEGIN SELECT RAISE(ABORT,'reject reported'); END;`); db.close();
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await expect(store.recordResponse(claim.record.receipt.claim, response, 4, measurement(admitted, response)))
    .rejects.toThrow('MODEL_INVOCATION_UNAVAILABLE'); store.close();
  expect(account(base.path)).toMatchObject({ reservedMinorUnits: 6, settledExactMinorUnits: '0', settledMinorUnits: 0 });
  const check = new DatabaseSync(base.path, { readOnly: true });
  try { expect(settlementSnapshot(check)).toEqual(before); }
  finally { check.close(); }
});
