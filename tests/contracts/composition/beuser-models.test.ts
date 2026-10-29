import { beforeEach, expect, it, vi } from 'vitest';
import { CORE_MODEL_ROLES, beuserEvaluatorPrincipalRef, verifiedPrincipalSchema, type ModelInvocationCommand, type ModelInvocationProfile } from '#domain/index.js';
import { BeuserCallBudget, providerSpendEvidenceDigest, type BeuserContext } from '#engine/index.js';
import type { ModelInvocationResult, ModelInvocationSpending } from '#engine/core/model-invocation/index.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as httpTransport from '#adapters/core/provider-http-json/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { configuredBeuserModels } from '#composition/core/beuser/index.js';

const mocks = vi.hoisted(() => ({ scope: vi.fn(), catalog: vi.fn(), activation: vi.fn(), command: vi.fn(), prepare: vi.fn(), invoke: vi.fn() }));
vi.mock('#composition/core/scoped-request/index.js', () => ({ loadConfiguredScopeContext: mocks.scope }));
vi.mock('#composition/core/model-activation/index.js', () => ({ inspectConfiguredModelCatalog: mocks.catalog }));
vi.mock('#composition/core/model-invocation/index.js', () => ({ prepareConfiguredModelAs: mocks.prepare, invokeConfiguredModelAs: mocks.invoke }));
vi.mock('#composition/core/terminal-chat/index.js', () => ({ prepareTerminalChatCommand: mocks.command }));
vi.mock('#adapters/index.js', async original => ({ ...await original<typeof import('#adapters/index.js')>(),
  openSqliteModelActivationReader: async (...args: Parameters<typeof import('#adapters/index.js').openSqliteModelActivationReader>) => args[0] === '/fixture.sqlite'
    ? { loadRecord: mocks.activation, close() {} } : (await original<typeof import('#adapters/index.js')>()).openSqliteModelActivationReader(...args) }));

const target = CORE_MODEL_ROLES.models.find(row => row.roles.includes('beuser-walker'))!;
const reference = { providerId: target.channelId, providerVersion: 1, modelId: 'catalog-model', modelVersion: 1 };
const limits = { schemaVersion: 1 as const, revision: 'fixture', source: 'test-only', provisional: true, maxSteps: 10, maxWallMs: 1000, maxWaitMs: 100,
  maxCalls: 10, maxTokens: 131072, maxCost: 1, currency: 'USD', maxReruns: 1, maxTranscriptBytes: 10000, maxArtifactBytes: 10000, cleanupDeadlineMs: 100, criticalRepetitions: 1 };
const context = { binding: { schemaVersion: 1, identity: { scopeId: 'scope', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 },
  candidate: { adapter: 'crm', version: 'v1', evidenceRef: 'subject', stateDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) }, candidateDigest: 'c'.repeat(64),
  personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64), realmId: 'realm', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'transcript' },
principal: verifiedPrincipalSchema.parse({ id: 'evaluator', ...beuserEvaluatorPrincipalRef({ issuer: 'host', subject: 'person' }), assurance: 'workload-verified', scopeIds: ['scope'] }),
limits, signal: new AbortController().signal } as BeuserContext;
const localProfile: ModelInvocationProfile = { schemaVersion: 2, billingAxis: 'local', id: 'profile', version: 1, scopeId: 'scope', reference,
  bindingDigest: 'a'.repeat(64), protocol: { family: 'fixture', version: '1' }, contextWindowTokens: 196608,
  adapter: { id: 'fixture', version: 1, definition: { endpoint: 'http://127.0.0.1:8000/v1/chat/completions', tariff: { kind: 'operator-static', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } } },
  allocation: { id: 'allocation', maxCalls: 10, maxInFlight: 1 }, limits: { requestMaxBytes: 1000000, responseMaxBytes: 1000, timeoutMs: 1000 } };
const command: ModelInvocationCommand = { schemaVersion: 1, commandId: 'call', scopeId: 'scope', reference, catalogRevision: 'c1',
  expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) },
  nativeRequest: { model: target.modelId, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 10 } };
function quote(maxChargeMinorUnits = 0) {
  const definition = { kind: 'operator-static', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 }, evidence = { kind: 'fixture' };
  return { schemaVersion: 1 as const, scopeId: 'scope', requestDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64), currency: 'USD', maxChargeMinorUnits,
    pricing: { id: 'fixture', version: 1, digest: providerSpendEvidenceDigest(definition), definition },
    meter: { id: 'fixture', version: 1, evidenceDigest: providerSpendEvidenceDigest(evidence), evidence } };
}
// The transport is substituted, while the composition, role/activation checks and budget are real.
function harness(overrides: Partial<typeof limits> = {}) {
  const ctx = { ...context, limits: { ...limits, ...overrides } }, budget = new BeuserCallBudget(ctx.limits);
  const { models } = configuredBeuserModels('/fixture', {}, ctx, { 'beuser-walker': target, 'beuser-evaluator': target }, [{ vendorId: 'fixture-contributor' }], budget, 10, () => ({}));
  return { budget, call: () => models.evaluate(ctx, 'f'.repeat(64)) };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({ config: { model_roles: undefined, storage: { sqlite: {} },
    provider_catalog: { schemaVersion: 1, revision: 'c1', providers: [{ id: target.channelId, version: 1, models: [{ id: 'catalog-model', version: 1, nativeId: target.modelId, protocols: [{ family: 'fixture', version: '1', capabilities: [] }] }] }] },
    provider_invocation_profiles: { profiles: [localProfile] } }, path: async () => '/fixture.sqlite' });
  mocks.catalog.mockResolvedValue({ schemaVersion: 1, scopeId: 'scope', channels: [{ channelId: target.channelId, access: 'allowed', models: [{ modelId: target.modelId, model: { vendorId: 'anthropic' } }] }] });
  mocks.activation.mockResolvedValue({ state: 'active' });
  mocks.command.mockResolvedValue({ command });
  mocks.prepare.mockResolvedValue({ measurement: { quality: 'provider-count', promptTokens: 136, windowTokens: null }, profile: localProfile, spending: null });
  mocks.invoke.mockResolvedValue({ receipt: { claim: { invocationId: 'invocation' }, outcome: { state: 'responded' } }, response: { usage: null } } as unknown as ModelInvocationResult);
});

it('reserves the small prompt plus completion for a 196k-window local unmetered model and exhausts the token envelope on the third call', async () => {
  // Provider measures 136 prompt tokens, including its template; plus 10 completion = 146.
  const h = harness({ maxTokens: 300 });
  await expect(h.call()).resolves.toMatchObject({ state: 'invoked' });
  expect(h.budget.remaining()).toEqual({ calls: 9, tokens: 154, cost: 1, currency: 'USD' });
  await h.call();
  expect(h.budget.remaining().tokens).toBe(8);
  await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it('refuses oversized and multibyte prompts before invoking rather than clipping the reservation to the model window', async () => {
  const h = harness();
  mocks.command.mockResolvedValue({ command: { ...command, nativeRequest: { ...command.nativeRequest, messages: [{ role: 'user', content: '界'.repeat(100000) }] } } });
  mocks.prepare.mockResolvedValueOnce({ profile: localProfile, spending: null, measurement: { quality: 'provider-count', promptTokens: 300000, windowTokens: null } });
  await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(h.budget.remaining()).toMatchObject({ calls: 10, tokens: 131072 });
  mocks.prepare.mockResolvedValue({ measurement: { quality: 'provider-count', promptTokens: 136, windowTokens: null }, profile: { ...localProfile, contextWindowTokens: 145 }, spending: null });
  mocks.command.mockResolvedValue({ command });
  await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('settles final provider usage down while retaining call and money limits, and refuses an overrun without increasing the reservation', async () => {
  const h = harness({ maxTokens: 300, maxCalls: 2 });
  mocks.invoke.mockResolvedValue({ receipt: { claim: { invocationId: 'invocation' }, outcome: { state: 'responded' } }, response: { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } });
  await h.call();
  expect(h.budget.remaining()).toEqual({ calls: 1, tokens: 290, cost: 1, currency: 'USD' });
  mocks.invoke.mockResolvedValue({ receipt: { claim: { invocationId: 'invocation' }, outcome: { state: 'responded' } }, response: { usage: { prompt_tokens: 149, completion_tokens: 1, total_tokens: 150 } } });
  await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(h.budget.remaining()).toEqual({ calls: 0, tokens: 144, cost: 1, currency: 'USD' });
  await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it('keeps the reservation for unknown, missing, malformed or thrown provider results', async () => {
  const h = harness({ maxTokens: 1000 });
  mocks.invoke.mockResolvedValueOnce({ receipt: { claim: { invocationId: 'invocation' }, outcome: { state: 'unknown' } }, response: { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } });
  await h.call(); // Even a counter attached to an unknown result cannot release tokens.
  await h.call(); // Missing usage.
  mocks.invoke.mockResolvedValueOnce({ receipt: { claim: { invocationId: 'invocation' }, outcome: { state: 'responded' } }, response: { usage: { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 } } });
  await h.call();
  mocks.invoke.mockRejectedValueOnce(new Error('TRANSPORT_UNKNOWN'));
  await expect(h.call()).rejects.toThrow('TRANSPORT_UNKNOWN');
  expect(h.budget.remaining()).toEqual({ calls: 6, tokens: 416, cost: 1, currency: 'USD' });
});

it('requires a quote for paid profiles and refuses a local label without literal-loopback and zero-tariff evidence', async () => {
  const h = harness();
  mocks.prepare.mockResolvedValue({ measurement: { quality: 'provider-count', promptTokens: 136, windowTokens: null }, profile: { ...localProfile, billingAxis: 'metered' }, spending: null });
  await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  mocks.prepare.mockResolvedValue({ measurement: { quality: 'provider-count', promptTokens: 136, windowTokens: null }, profile: { ...localProfile, adapter: { ...localProfile.adapter, definition: { ...localProfile.adapter.definition, endpoint: 'https://remote.example/v1/chat/completions' } } }, spending: null });
  await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  mocks.prepare.mockResolvedValue({ measurement: { quality: 'provider-count', promptTokens: 136, windowTokens: null }, profile: { ...localProfile, adapter: { ...localProfile.adapter, definition: { ...localProfile.adapter.definition, tariff: { kind: 'operator-static', inputMinorUnitsPerMillionTokens: 1, outputMinorUnitsPerMillionTokens: 0 } } } }, spending: null });
  await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  mocks.prepare.mockResolvedValue({ measurement: { quality: 'provider-count', promptTokens: 136, windowTokens: null }, profile: { ...localProfile, billingAxis: 'metered' }, spending: { quote: { currency: 'EUR' }, budget: null } as unknown as ModelInvocationSpending });
  await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(h.budget.remaining()).toMatchObject({ calls: 10, tokens: 131072, cost: 1 });
});

it('accepts the existing local zero quote and keeps paid same-currency quote amounts inside the money envelope', async () => {
  const h = harness();
  mocks.prepare.mockResolvedValue({ measurement: { quality: 'provider-count', promptTokens: 136, windowTokens: null }, profile: localProfile, spending: { budget: null, quote: quote() } });
  await h.call();
  expect(h.budget.remaining().cost).toBe(1);
  mocks.prepare.mockResolvedValue({ measurement: { quality: 'provider-count', promptTokens: 136, windowTokens: null }, profile: { ...localProfile, billingAxis: 'metered' }, spending: { budget: {}, quote: quote(6) } });
  await h.call();
  expect(h.budget.remaining().cost).toBe(0.94);
  mocks.prepare.mockResolvedValue({ measurement: { quality: 'provider-count', promptTokens: 136, windowTokens: null }, profile: { ...localProfile, billingAxis: 'metered' }, spending: { budget: {}, quote: quote(95) } });
  await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});


it('refuses a missing or untrusted counter before spending any call or token reservation', async () => {
  const h = harness();
  for (const measurement of [null, { quality: 'upper-bound', promptTokens: 1, windowTokens: null }]) {
    mocks.prepare.mockResolvedValueOnce({ profile: localProfile, spending: null, measurement });
    await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  }
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(h.budget.remaining()).toMatchObject({ calls: 10, tokens: 131072, cost: 1 });
});

it('respects the measured served window even when the configured context is larger', async () => {
  const h = harness();
  mocks.prepare.mockResolvedValue({ profile: localProfile, spending: null,
    measurement: { quality: 'provider-count', promptTokens: 136, windowTokens: 145 } });
  await expect(h.call()).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(mocks.invoke).not.toHaveBeenCalled();
});


it('production preflight counts the rendered request through the provider adapter, reserving template tokens before inference and refusing unsupported counters', async () => {
  // Only catalog projection and the remote HTTP effect are substituted. Config, policy, activation, preflight and native codec are real.
  const f = await brainProviderFixture({ noCharge: true, budget: null, tokenCount: { count: 700, max_model_len: 1000 }, contextWindow: 2000, maxOutputTokens: 32,
    modelRoles: { schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'beuser-fixture', roles: [], exceptions: [], models: [
      { channelId: 'test-operator', modelId: 'vendor/model', version: 1, tier: 'frontier', roles: ['beuser-walker', 'beuser-evaluator'] }] }] } });
  try {
    const scoped = await vi.importActual<typeof import('#composition/core/scoped-request/index.js')>('#composition/core/scoped-request/index.js');
    const invocation = await vi.importActual<typeof import('#composition/core/model-invocation/index.js')>('#composition/core/model-invocation/index.js');
    const terminal = await vi.importActual<typeof import('#composition/core/terminal-chat/index.js')>('#composition/core/terminal-chat/index.js');
    mocks.scope.mockImplementation(scoped.loadConfiguredScopeContext);
    mocks.prepare.mockImplementation(invocation.prepareConfiguredModelAs);
    mocks.invoke.mockImplementation(invocation.invokeConfiguredModelAs);
    mocks.command.mockImplementation(terminal.prepareTerminalChatCommand);
    mocks.catalog.mockResolvedValue({ schemaVersion: 1, scopeId: 's', channels: [{ channelId: f.reference.providerId, access: 'allowed',
      models: [{ modelId: 'vendor/model', model: { vendorId: 'anthropic' } }] }] });
    const ctx: BeuserContext = { ...context, binding: { ...context.binding, identity: { ...context.binding.identity, scopeId: 's' } },
      principal: { ...context.principal, scopeIds: ['s'] }, limits: { ...limits, maxTokens: 710, maxWallMs: 5000, maxArtifactBytes: 20000 } };
    const policyPath = join(f.data, 'policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy.grants.push({ id: 'beuser-invoke', effect: 'allow', scopes: ['s'], principals: [{ issuer: ctx.principal.issuer, subject: ctx.principal.subject }],
      actions: ['invoke'], resource: { kind: 'model-invocation', ids: 'all' } });
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
    const budget = new BeuserCallBudget(ctx.limits), choice = { channelId: f.reference.providerId, modelId: 'vendor/model' };
    const { models } = configuredBeuserModels(f.project, f.options, ctx, { 'beuser-walker': choice, 'beuser-evaluator': choice },
      [{ vendorId: 'fixture-contributor' }], budget, 10, () => ({ template: 'fixture-evidence' }));
    const send = vi.mocked(httpTransport.sendNativeJsonHttp), effect = send.getMockImplementation()!;
    send.mockImplementation(async (...args) => {
      if (args[0].definition.endpoint.endsWith('/chat')) expect(budget.remaining().tokens).toBe(0);
      return effect(...args);
    });
    await expect(models.evaluate(ctx, 'f'.repeat(64))).resolves.toMatchObject({ state: 'invoked' });
    expect(f.posts).toBe(1);
    const measured = JSON.parse(f.counterBodies[0]!), sent = JSON.parse(f.bodies[0]!);
    expect(measured).toEqual({ model: sent.model, messages: sent.messages });
    expect(measured.messages[0].content).toContain('fixture-evidence');
    expect(budget.remaining().tokens).toBe(698); // Final usage 12; only tokens are returned.
    await expect(models.evaluate(ctx, 'f'.repeat(64))).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
    expect(f.posts).toBe(1); // Template expansion no longer fits; rejected before inference.
    // A connection without a tokenizer endpoint cannot supply a measured count.
    const configPath = join(f.project, '.deckent/config.json');
    delete (f.config.provider_invocation_profiles.profiles[0]!.adapter.definition as Record<string, unknown>).tokenizeEndpoint;
    await writeFile(configPath, JSON.stringify(f.config));
    const { clearConfigCache } = await import('#platform/index.js'); clearConfigCache();
    await expect(models.evaluate(ctx, 'f'.repeat(64))).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
    expect(f.posts).toBe(1); expect(f.counterBodies).toHaveLength(2);
  } finally { await f.close(); }
});
