import { expect, it } from 'vitest';
import { modelInvocationProfileSchema, nativeCliIds, executionProfileDefinitionSchema } from '#domain/index.js';
import { classifyWorkSpending, workSpendingBasis, workerBillingAxis } from '#engine/index.js';
const worker = executionProfileDefinitionSchema.parse({ id: 'worker', version: 1, adapter: { id: 'fixture', version: 1 }, parameters: {} });
const model = modelInvocationProfileSchema.parse({ schemaVersion: 1, id: 'local', version: 1, scopeId: 's',
  reference: { providerId: 'fixture', providerVersion: 1, modelId: 'local', modelVersion: 1 }, bindingDigest: 'a'.repeat(64),
  protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'fixture', version: 1,
    definition: { endpoint: 'https://127.0.0.1/chat', tariff: { kind: 'operator-static', version: 2, currency: 'USD',
      inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } } },
  allocation: { id: 'local', maxCalls: 1, maxInFlight: 1 }, limits: { requestMaxBytes: 1000, responseMaxBytes: 1000, timeoutMs: 1000 } });
it('unknown or malformed worker bindings are metered; registered subscription binding is not', () => {
  expect(classifyWorkSpending({ kind: 'worker', profile: null })).toBe('metered');
  for (const nativeSubscription of [undefined, null, 'subscription', {}, { schemaVersion: 2, provider: 'unregistered' }, { schemaVersion: 99, provider: nativeCliIds[0] }]) {
    const profile = nativeSubscription === undefined ? worker : executionProfileDefinitionSchema.parse({ ...worker, parameters: { nativeSubscription } });
    expect(classifyWorkSpending({ kind: 'worker', profile })).toBe('metered');
  }
  for (const provider of nativeCliIds) expect(classifyWorkSpending({ kind: 'worker', profile: { ...worker,
    parameters: { nativeSubscription: { schemaVersion: 2, provider } } } })).toBe('not-metered');
});
it('only literal zero tariff with exclusively literal loopback endpoints exempts a planning model', () => {
  expect(classifyWorkSpending({ kind: 'model', profile: null })).toBe('metered');
  expect(classifyWorkSpending({ kind: 'model', profile: model })).toBe('not-metered');
  const definition = model.adapter.definition;
  for (const endpoint of ['https://localhost/chat', 'https://10.0.0.1/chat', 'https://api.example/chat'])
    expect(classifyWorkSpending({ kind: 'model', profile: { ...model, adapter: { ...model.adapter, definition: { ...definition, endpoint } } } })).toBe('metered');
  expect(classifyWorkSpending({ kind: 'model', profile: { ...model, adapter: { ...model.adapter, definition: { ...definition, tokenizeEndpoint: 'https://api.example/tokenize' } } } })).toBe('metered');
  for (const tariff of [undefined, {}, { kind: 'operator-static', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 1 },
    { kind: 'operator-static', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0, cachedInputMinorUnitsPerMillionTokens: 1 }])
    expect(classifyWorkSpending({ kind: 'model', profile: { ...model, adapter: { ...model.adapter, definition: tariff === undefined ? { endpoint: definition['endpoint']! } : { ...definition, tariff } } } })).toBe('metered');
});

it('only subscription-only selections waive the budget; a mixed or unresolved target stays metered', () => {
  const subscription = { ...worker, parameters: { nativeSubscription: { schemaVersion: 2, provider: nativeCliIds[0]! } } };
  expect(workSpendingBasis([subscription, subscription]).semantics).toBe('not-metered');
  expect(workSpendingBasis([subscription, worker]).semantics).toBe('metered');
  expect(workSpendingBasis([subscription, null]).semantics).toBe('metered');
  expect(workSpendingBasis([subscription]).digest).not.toBe(workSpendingBasis([worker]).digest);
});

it('a worker declaring the local billing axis is not metered; an absent, malformed or subscription-mixed declaration keeps today\'s class', () => {
  const local = executionProfileDefinitionSchema.parse({ ...worker, parameters: { billingAxis: 'local' } });
  expect(workerBillingAxis(local)).toBe('local');
  expect(classifyWorkSpending({ kind: 'worker', profile: local })).toBe('not-metered');
  for (const billingAxis of ['metered', 'subscription', 'LOCAL', null, { axis: 'local' }]) {
    const profile = executionProfileDefinitionSchema.parse({ ...worker, parameters: { billingAxis } });
    expect(workerBillingAxis(profile)).toBeNull();
    expect(classifyWorkSpending({ kind: 'worker', profile })).toBe('metered');
  }
  // A subscription binding stays the subscription axis; the declaration never relabels it.
  expect(workerBillingAxis({ ...worker, parameters: { billingAxis: 'local', nativeSubscription: { schemaVersion: 2, provider: nativeCliIds[0]! } } })).toBe('subscription');
  const subscription = { ...worker, parameters: { nativeSubscription: { schemaVersion: 2, provider: nativeCliIds[0]! } } };
  expect(workSpendingBasis([subscription, local]).semantics).toBe('not-metered');
  expect(workSpendingBasis([local, worker]).semantics).toBe('metered');
  expect(workSpendingBasis([local]).digest).not.toBe(workSpendingBasis([worker]).digest);
});
