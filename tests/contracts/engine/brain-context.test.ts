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
  { context: { ...brainPlannerConfigSchema.parse({}).context, maxBytes: 4500 } }])('bounds 130 prepared profiles deterministically without prompts: %j', config => {
  const prompt = prepareBrainRegistryPrompt(command, registry, null, config);
  const context = JSON.parse(prompt.messages[1]!.content).context;
  expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThanOrEqual(brainPlannerConfigSchema.parse(config).context.maxBytes);
  expect(prompt.messages[1]!.content).not.toContain('PREPARED_PRIVATE_CARD');
  expect(context.context.schemaVersion).toBe(3); expect(context.context.memory).toBeNull(); // S4B-6: template v4 (default) plans with context v3
  expect(context.context.kinds.every((row: { type: string }) => row.type === 'prepared')).toBe(true);
  expect(context.context.truncation.omittedKinds).toBeGreaterThan(0);
  expect(context.context.truncation.reason).toBe(brainPlannerConfigSchema.parse(config).context.maxBytes === 4500 ? 'bytes' : 'count');
  expect(prepareBrainRegistryPrompt(command, { ...registry, kinds: [...registry.kinds].reverse(), profiles: [...registry.profiles].reverse() }, null, config).contextDigest).toBe(prompt.contextDigest);
  expect(context.context.evaluators[0].parameters.properties.acceptedExitCodes).toBeDefined();
  expect(context.context.evaluators[0].parameters.additionalProperties).toBe(false);
  console.log('brain-context-measurement:', JSON.stringify({ profiles: profiles.length, limits: brainPlannerConfigSchema.parse(config).context,
    registryBytes: new TextEncoder().encode(JSON.stringify(registry)).length,
    contextBytes: new TextEncoder().encode(JSON.stringify(context)).length, messagesBytes: new TextEncoder().encode(JSON.stringify(prompt.messages)).length,
    truncation: context.context.truncation, contextDigest: prompt.contextDigest }));
});
// alpha.56: the hub, installation inspect/uninstall/purge and nervous-rule vocabulary grew the fixed part past 4000 bytes again (4093), so the bytes case bounds at 4500.
// fs1 (alpha.55): the vocabulary's new resources grew the fixed part (permissions ~2 KB), so at 4000 bytes the kinds and the one evaluator list tied
// and the evaluator went first. A list now keeps its first row; a bound that cannot hold one kind and one evaluator is a typed refusal, never a context
// the Brain cannot plan a valid Run from.
it('negative: a byte bound below one kind and one evaluator refuses typed instead of dropping the last evaluator', () => {
  const tight = { context: { ...brainPlannerConfigSchema.parse({}).context, maxBytes: 3500 } };
  expect(() => prepareBrainRegistryPrompt(command, registry, null, tight)).toThrow(expect.objectContaining({ code: 'BRAIN_CONTEXT_TOO_LARGE', params: expect.objectContaining({ limit: 3500, unit: 'bytes' }) }));
});
// Model pins are offered only by a template that lets the Brain pin (v2); v3 (ATAMA-1) offers none (brain-assignment.test.ts).
it('preserves template metadata, model pins and both evaluator schemas without execution parameters', () => {
  const model = { profile: { id: 'template', version: 1 }, channelId: 'subscription-channel', modelId: 'exact-native-model', auxiliaryModelIds: ['exact-helper'],
    availableAuxiliaryModelIds: ['exact-helper'], billing: 'subscription', efforts: ['high'] };
  const projected = prepareBrainRegistryPrompt(command, { ...fixture, evaluators: [...fixture.evaluators,
    { id: 'customer-readback', version: 2, implementation: { id: 'operation-evidence', version: 1 } }] }, null, { selected: { id: 'run-proposal', version: 2 } }, undefined,
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
// Root cause of the 4000-byte failure: s0 put every class's full acceptance profile (rubric weights, ceiling rules, decision thresholds) and
// its proposal-admission risk into the planning context, ~2 KB the Brain must not plan against. The Brain sees what it may declare (criterion
// and evidence types per class) and the class/binding vocabulary; scoring internals, standing-admission data and worker lists stay out.
it('the planning context names each class with its declarable criterion and evidence types, never its scoring, admission or worker data', () => {
  const content = prepareBrainRegistryPrompt(command, fixture, null, {}).messages[1]!.content, view = JSON.parse(content).context.workClasses;
  expect(view.classes.find((row: { id: string }) => row.id === 'feature')).toEqual({ id: 'feature', defaultEffort: 'xhigh',
    acceptance: { criterionTypes: ['completion'], evidenceTypes: ['retained-artifact'] } });
  expect(view.bindings).toContainEqual({ kind: 'coding', classId: 'feature' });
  for (const hidden of ['rubric', 'ceilingRules', 'decisionThresholds', 'proposalAdmission', 'standingAdmission', 'candidatePolic', 'inactivity'])
    expect(content, hidden).not.toContain(hidden);
});
