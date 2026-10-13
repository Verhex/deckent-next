import { expect, it } from 'vitest';
import { executionRegistrySchema, type ModelInvocationCommand } from '#domain/index.js';
import { prepareBrainRegistryPrompt, assertBrainContextFits } from '#engine/index.js';
import { brainPlannerConfigSchema } from '#capabilities/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
const command = { schemaVersion: 1 as const, scopeId: 's', commandId: 'brain', intent: 'Prepare the explicit customer operation' };
const fixture = fixtureDockerRegistry(['purchase']);
const profiles = Array.from({ length: 130 }, (_, i) => ({ ...fixture.profiles[0]!, id: 'profile-' + i,
  parameters: { ...fixture.profiles[0]!.parameters, prompt: 'PREPARED_PRIVATE_CARD'.repeat(1000) } }));
const registry = executionRegistrySchema.parse({ ...fixture, profiles,
  kinds: profiles.map(row => ({ kind: row.id, profile: { id: row.id, version: row.version } })) });
it.each([{}, { context: { ...brainPlannerConfigSchema.parse({}).context, maxKinds: 5 } },
  { context: { ...brainPlannerConfigSchema.parse({}).context, maxBytes: 4000 } }])('bounds 130 prepared profiles deterministically without prompts: %j', config => {
  const prompt = prepareBrainRegistryPrompt(command, registry, null, config);
  const context = JSON.parse(prompt.messages[1]!.content).context;
  expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThanOrEqual(brainPlannerConfigSchema.parse(config).context.maxBytes);
  expect(prompt.messages[1]!.content).not.toContain('PREPARED_PRIVATE_CARD');
  expect(context.context.schemaVersion).toBe(2);
  expect(context.context.kinds.every((row: { type: string }) => row.type === 'prepared')).toBe(true);
  expect(context.context.truncation.omittedKinds).toBeGreaterThan(0);
  expect(context.context.truncation.reason).toBe(brainPlannerConfigSchema.parse(config).context.maxBytes === 4000 ? 'bytes' : 'count');
  expect(prepareBrainRegistryPrompt(command, { ...registry, kinds: [...registry.kinds].reverse(), profiles: [...registry.profiles].reverse() }, null, config).contextDigest).toBe(prompt.contextDigest);
  expect(context.context.evaluators[0].parameters.properties.acceptedExitCodes).toBeDefined();
  expect(context.context.evaluators[0].parameters.additionalProperties).toBe(false);
  console.log('brain-context-measurement:', JSON.stringify({ profiles: profiles.length, limits: brainPlannerConfigSchema.parse(config).context,
    registryBytes: new TextEncoder().encode(JSON.stringify(registry)).length,
    contextBytes: new TextEncoder().encode(JSON.stringify(context)).length, messagesBytes: new TextEncoder().encode(JSON.stringify(prompt.messages)).length,
    truncation: context.context.truncation, contextDigest: prompt.contextDigest }));
});
it('preserves template metadata, model pins and both evaluator schemas without execution parameters', () => {
  const model = { profile: { id: 'template', version: 1 }, channelId: 'subscription-channel', modelId: 'exact-native-model', auxiliaryModelIds: ['exact-helper'],
    availableAuxiliaryModelIds: ['exact-helper'], billing: 'subscription', efforts: ['high'] };
  const projected = prepareBrainRegistryPrompt(command, { ...fixture, evaluators: [...fixture.evaluators,
    { id: 'customer-readback', version: 2, implementation: { id: 'operation-evidence', version: 1 } }] }, null, {}, undefined,
    { kinds: [{ kind: 'purchase', profile: model.profile, type: 'template', provider: 'registered-provider' }], workerModels: [model] });
  const context = JSON.parse(projected.messages[1]!.content).context.context;
  expect(context.workerModels).toEqual([model]); expect(context.kinds[0].type).toBe('template');
  expect(context.evaluators.find((row: { id: string }) => row.id === 'customer-readback').parameters.properties.commandId).toBeDefined();
});
const invocation: ModelInvocationCommand = { schemaVersion: 1, commandId: 'invoke', scopeId: 's', reference: { providerId: 'fixture', providerVersion: 1, modelId: 'fixture', modelVersion: 1 },
  catalogRevision: 'fixture', expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) },
  nativeRequest: { messages: [{ role: 'user', content: 'prompt' }], max_completion_tokens: 100 } };
it.each([
  [1000, { promptTokens: 901, windowTokens: 2000 }, 'tokens'],
  [2000, { promptTokens: 901, windowTokens: 1000 }, 'tokens'],
  [1000, null, 'estimated-tokens'],
] as const)('refuses overflow with the narrower declared/measured window %s', (window, measured, unit) => {
  expect(() => assertBrainContextFits(invocation, {}, window, measured)).toThrow(expect.objectContaining({ code: 'BRAIN_CONTEXT_TOO_LARGE', params: expect.objectContaining({ unit }) }));
  expect(() => assertBrainContextFits(invocation, {}, 1001, { promptTokens: 901, windowTokens: 1001 })).not.toThrow();
});
it('enforces byte limits even without a declared window or a provider counter', () => {
  expect(() => assertBrainContextFits(invocation, { context: { ...brainPlannerConfigSchema.parse({}).context, requestMaxBytes: 1 } }, null, null))
    .toThrow(expect.objectContaining({ code: 'BRAIN_CONTEXT_TOO_LARGE' }));
  expect(() => prepareBrainRegistryPrompt(command, registry, null, { context: { ...brainPlannerConfigSchema.parse({}).context, maxBytes: 1 } }))
    .toThrow(expect.objectContaining({ code: 'BRAIN_CONTEXT_TOO_LARGE' }));
});
