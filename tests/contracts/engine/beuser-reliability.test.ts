import { expect, it, vi } from 'vitest';
import { beuserEvaluatorPrincipalRef, verifiedPrincipalSchema, type ModelActivationRecord } from '#domain/index.js';
import { beuserBindingSchema, beuserVerdictSchema } from '#domain/core/beuser/index.js';
import { pinBeuserLimits, type BeuserContext } from '#engine/core/beuser-contract/index.js';
import { BeuserCallBudget, BeuserExecutionBudget, beuserIndependentRows, assessBeuserReliability, runBeuserReliability, createBeuserModelPort, type BeuserModelComposition, type BeuserReliabilitySample } from '#engine/core/beuser/index.js';
import type { ModelInvocationResult } from '#engine/core/model-invocation/index.js';
import { inspectRoleModelsInScope, type ModelCatalogInspection } from '#engine/core/model-activation/index.js';

const limits = pinBeuserLimits({ schemaVersion: 1, revision: 'test-limits', source: 'fixture', provisional: true, maxSteps: 4, maxWallMs: 1000, maxWaitMs: 100,
  maxCalls: 2, maxTokens: 100, maxCost: 1, currency: 'USD', maxReruns: 1, maxTranscriptBytes: 10000, maxArtifactBytes: 10000, cleanupDeadlineMs: 100, criticalRepetitions: 1 });
const binding = beuserBindingSchema.parse({ schemaVersion: 1, identity: { scopeId: 'scope', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 },
  candidate: { adapter: 'crm', version: 'v1', evidenceRef: 'subject', stateDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) }, candidateDigest: 'c'.repeat(64),
  personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64), realmId: 'realm', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'transcript' });
const verdict = beuserVerdictSchema.parse({ schemaVersion: 1, binding, transcriptDigest: 'a'.repeat(64), outcome: 'GREEN', authorization: 'pass', safety: 'pass', experience: 'pass', validity: 'valid', independence: 'independent', evidenceRefs: ['retained'] });
const calibration = { revision: 'blind-v1', blindSetDigest: 'b'.repeat(64), bad: 10, hits: 10, good: 10, falseReds: 0 };
const policy = { revision: 'policy-v1', minHitRate: 0.9, maxFalseRedRate: 0.1 };
const sample = (overrides: Partial<BeuserReliabilitySample> = {}): BeuserReliabilitySample => ({ verdict, calibration, independent: true, repetitions: [verdict], cleanupProven: true,
  unresolvedEffects: false, choice: { modelKey: 'first', personaDigest: binding.personaDigest }, ...overrides });

it('all contributors plus walker makers exclude aliases, same-maker channels and null provenance', () => {
  const rows = [{ id: 'alias', vendorId: 'zhipu' }, { id: 'same', vendorId: 'zai' }, { id: 'other', vendorId: 'other' }, { id: 'unknown' }];
  expect(beuserIndependentRows(rows, row => 'vendorId' in row ? row.vendorId! : null, [{ vendorId: 'zai' }], [{ vendorId: 'walker' }]).map(row => row.id)).toEqual(['other']);
  expect(beuserIndependentRows(rows, row => row.vendorId === 'zhipu' ? 'zai' : row.vendorId ?? null, [{ vendorId: 'zhipu' }], [{ vendorId: 'walker' }]).map(row => row.id)).toEqual(['other']);
  expect(beuserIndependentRows(rows, row => row.vendorId ?? null, [null], [{ vendorId: 'walker' }])).toEqual([]);
  expect(beuserIndependentRows(rows, row => row.vendorId ?? null, [{ vendorId: 'source' }], [null])).toEqual([]);
});

it('uses hit/false-RED counts and frozen thresholds; confidence or selectedProbability cannot replace them', () => {
  expect(assessBeuserReliability(sample(), limits, policy)).toMatchObject({ outcome: 'GREEN', calibrated: true, acceptanceEvidence: true, hitRate: 1, falseRedRate: 0 });
  expect(assessBeuserReliability(sample({ verdict: { ...verdict, independence: 'unknown' } }), limits, policy)).toMatchObject({ independence: 'reduced' });
  expect(assessBeuserReliability(sample({ calibration: { ...calibration, hits: 8 } }), limits, policy)).toMatchObject({ outcome: 'unknown', calibrated: false, acceptanceEvidence: false });
  expect(assessBeuserReliability(sample({ calibration: { ...calibration, falseReds: 2 } }), limits, policy)).toMatchObject({ outcome: 'unknown', calibrated: false });
  expect(() => assessBeuserReliability(sample({ calibration: { ...calibration, hits: 11 } }), limits, policy)).toThrow();
  expect(() => assessBeuserReliability(sample({ calibration: { ...calibration, confidence: 1, selectedProbability: 1 } as typeof calibration }), limits, policy)).toThrow();
});

it('a lost Attempt retry is not another independent critical repetition and a missing k remains unknown', () => {
  const retried = { ...verdict, binding: { ...binding, identity: { ...binding.identity, attemptId: 'retry', generation: 2 } } };
  expect(assessBeuserReliability(sample({ repetitions: [verdict, retried] }), { ...limits, criticalRepetitions: 2 }, policy)).toMatchObject({ outcome: 'unknown', completedCriticalRepetitions: 1 });
  const second = { ...verdict, binding: { ...binding, identity: { ...binding.identity, taskId: 'repeat-2' } } };
  expect(assessBeuserReliability(sample({ repetitions: [verdict, second] }), { ...limits, criticalRepetitions: 2 }, policy)).toMatchObject({ outcome: 'unknown', completedCriticalRepetitions: 1 });
  const freshRealm = { ...second, binding: { ...second.binding, realmId: 'repeat-realm', nonce: '22345678-1234-4234-8234-123456789abc' } };
  expect(assessBeuserReliability(sample({ repetitions: [verdict, freshRealm] }), { ...limits, criticalRepetitions: 2 }, policy)).toMatchObject({ outcome: 'GREEN', completedCriticalRepetitions: 2 });
});

it('bounded changed-model reruns preserve the blind set/rubric and RED even if the last run is green', async () => {
  const first = sample({ verdict: { ...verdict, outcome: 'RED', safety: 'fail' }, independent: false });
  const rerun = vi.fn(async choice => sample({ choice, verdict: { ...verdict, binding: { ...binding, identity: { ...binding.identity, taskId: 'new-task' }, realmId: 'new-realm', nonce: '22345678-1234-4234-8234-123456789abc' } } }));
  const result = await runBeuserReliability({ budget: new BeuserExecutionBudget(limits), limits, policy, first, alternatives: [first.choice, { modelKey: 'changed', personaDigest: binding.personaDigest }, { modelKey: 'unused', personaDigest: binding.personaDigest }], rerun });
  expect(result).toMatchObject({ outcome: 'RED', reruns: 1 });
  expect(rerun).toHaveBeenCalledTimes(1);
  const low = sample({ calibration: { ...calibration, hits: 1 } });
  const stillLow = vi.fn(async choice => ({ ...await rerun(choice), calibration: low.calibration }));
  expect(await runBeuserReliability({ budget: new BeuserExecutionBudget(limits), limits, policy, first: low, alternatives: [{ modelKey: 'changed', personaDigest: binding.personaDigest }], rerun: stillLow })).toMatchObject({ outcome: 'unknown', acceptanceEvidence: false, reruns: 1 });
});

it('exhausted independence reports reduced without an owner step; uncertain effect or unproved cleanup never reruns', async () => {
  const rerun = vi.fn();
  expect(await runBeuserReliability({ budget: new BeuserExecutionBudget(limits), limits, policy, first: sample({ independent: false }), alternatives: [], rerun })).toMatchObject({ independence: 'reduced', reruns: 0 });
  // Reduced mode (BeUser): the label is information; a calibrated reduced walk keeps its outcome and never reruns for independence.
  expect(await runBeuserReliability({ budget: new BeuserExecutionBudget(limits), limits, policy, independence: 'reduced', first: sample({ independent: false }),
    alternatives: [{ modelKey: 'other', personaDigest: binding.personaDigest }], rerun })).toMatchObject({ outcome: 'GREEN', acceptanceEvidence: true, independence: 'reduced', reruns: 0 });
  for (const first of [sample({ independent: false, unresolvedEffects: true }), sample({ independent: false, cleanupProven: false })]) {
    expect(await runBeuserReliability({ budget: new BeuserExecutionBudget(limits), limits, policy, first, alternatives: [{ modelKey: 'other', personaDigest: binding.personaDigest }], rerun })).toMatchObject({ outcome: 'unknown', reruns: 0 });
  }
  expect(rerun).not.toHaveBeenCalled();
});

it('changed blind seeds/rubric and same-Task relaunches are refused instead of laundering calibration', async () => {
  const first = sample({ independent: false }), choice = { modelKey: 'changed', personaDigest: binding.personaDigest };
  await expect(runBeuserReliability({ budget: new BeuserExecutionBudget(limits), limits, policy, first, alternatives: [choice], rerun: async () => sample({ choice }) })).rejects.toThrow('BEUSER_INPUT_INVALID');
  await expect(runBeuserReliability({ budget: new BeuserExecutionBudget(limits), limits, policy, first, alternatives: [choice], rerun: async () => sample({ choice,
    calibration: { ...calibration, blindSetDigest: '0'.repeat(64) } }) })).rejects.toThrow('BEUSER_INPUT_INVALID');
});

it('invocation envelope reservations are finite across reruns and remain charged after an uncertain call', () => {
  const budget = new BeuserCallBudget(limits);
  budget.reserve(60, 0.6, 'USD');
  expect(budget.remaining()).toMatchObject({ calls: 1, tokens: 40, cost: 0.4 });
  expect(() => budget.reserve(41, 0, 'USD')).toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(() => budget.reserve(1, 0, 'other')).toThrow('BEUSER_LIMITS_UNAVAILABLE');
  budget.reserve(40, 0.4, 'USD');
  expect(() => budget.reserve(1, 0, 'USD')).toThrow('BEUSER_LIMITS_UNAVAILABLE');
});

it('settles only its own token reservation once and never refunds call or cost limits', () => {
  const budget = new BeuserCallBudget(limits), first = budget.reserve(60, 0.6, 'USD'), second = budget.reserve(40, 0.4, 'USD');
  expect(() => first(61)).toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(() => first(-1)).toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(() => first(Number.NaN)).toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(budget.remaining()).toEqual({ calls: 0, tokens: 0, cost: 0, currency: 'USD' });
  second(20); first(10);
  expect(budget.remaining()).toEqual({ calls: 0, tokens: 70, cost: 0, currency: 'USD' });
  expect(() => first(0)).toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(() => budget.reserve(1, 0, 'USD')).toThrow('BEUSER_LIMITS_UNAVAILABLE');
});

it('reruns receive the original execution envelope and cannot reset steps or an expired deadline', async () => {
  const bounds = { ...limits, maxSteps: 1 }, budget = new BeuserExecutionBudget(bounds);
  budget.step();
  const rerun = vi.fn(async (_choice, _previous, envelope) => { expect(envelope).toBe(budget); envelope.step(); return sample(); });
  expect(await runBeuserReliability({ budget, limits: bounds, policy, first: sample({ independent: false }),
    alternatives: [{ modelKey: 'changed', personaDigest: binding.personaDigest }], rerun })).toMatchObject({ outcome: 'unknown', acceptanceEvidence: false, reruns: 1,
      rerunEvidence: [{ reason: 'independence', state: 'unknown' }] });
  expect(rerun).toHaveBeenCalledOnce();
  expect(budget.signal.aborted).toBe(true);
});

function modelHarness(maker: object = { vendorId: 'zhipu' }) {
  const target = { channelId: 'local-vllm', modelId: 'qwen-fixture' }; // no tier/role row: the connected BeUser roles take it
  const reference = { providerId: target.channelId, providerVersion: 1, modelId: 'catalog-model', modelVersion: 1 };
  const principal = verifiedPrincipalSchema.parse({ id: 'evaluator', ...beuserEvaluatorPrincipalRef({ issuer: 'host', subject: 'person' }), assurance: 'workload-verified', scopeIds: ['scope'] });
  const ctx: BeuserContext = { binding, principal, limits, signal: new AbortController().signal };
  let active = true;
  const inspection: ModelCatalogInspection = { schemaVersion: 1, scopeId: 'scope', channels: [{ channelId: target.channelId, access: 'allowed', revision: 1, providerVersion: 1, catalogRevision: 'c1', channel: {} as never, activation: null,
    models: [{ modelId: target.modelId, revision: 1, model: maker as never, activation: null }] }] };
  const invoke = vi.fn(async () => ({ receipt: { claim: { invocationId: 'invocation' } } }) as unknown as ModelInvocationResult);
  const ports: BeuserModelComposition = { choices: { 'beuser-walker': target, 'beuser-evaluator': target }, contributorModels: [{ vendorId: 'zai' }], walkerModels: [{ vendorId: 'walker-maker' }], independence: 'required',
    invocation: { invoke }, credential: 'trusted-workload-fixture', now: () => Date.UTC(2026, 9, 29),
    sources: async () => ({ catalog: inspection, profiles: { profiles: [{ schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: 'a'.repeat(64), protocol: { family: 'fixture', version: '1' },
      adapter: { id: 'fixture', version: 1, definition: {} }, allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 1 }, limits: { requestMaxBytes: 1000, responseMaxBytes: 1000, timeoutMs: 1000 } }] },
    roles: { modelRoles: undefined, providerCatalog: { schemaVersion: 1, revision: 'c1', providers: [{ id: target.channelId, version: 1, models: [{ id: 'catalog-model', version: 1, nativeId: target.modelId, protocols: [{ family: 'fixture', version: '1', capabilities: [] }] }] }] },
      activation: async () => ({ state: active ? 'active' : 'inactive' }) as ModelActivationRecord } }),
    prepare: vi.fn(async (_ctx, _role, ref, input) => ({ command: { schemaVersion: 1 as const, commandId: 'call', scopeId: 'scope', reference: ref, catalogRevision: 'c1', expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'a'.repeat(64) }, nativeRequest: { input: input as never } }, tokens: 50, cost: 0.1, currency: 'USD' })),
    cancel: vi.fn() };
  return { ctx, ports, invoke, deactivate: () => { active = false; } };
}

it('an active connected model without a role row invokes; required independence refuses alias and unknown makers, reduced calls them and labels', async () => {
  const h = modelHarness(), models = createBeuserModelPort(h.ports, new BeuserCallBudget(limits)), roles = (await h.ports.sources(h.ctx)).roles;
  const listed = async () => (await inspectRoleModelsInScope(roles, 'beuser-walker', 'scope', h.ports.now())).models; // the setup check's read
  expect(await listed()).toEqual([{ channelId: 'local-vllm', modelId: 'qwen-fixture', tier: null, basis: 'connected', active: true }]);
  await expect(models.evaluate(h.ctx, 'a'.repeat(64))).resolves.toMatchObject({ state: 'unavailable', reason: 'independence' });
  expect(h.ports.prepare).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
  h.deactivate();
  expect(await listed()).toMatchObject([{ basis: 'connected', active: false }]);
  await expect(models.evaluate(h.ctx, 'a'.repeat(64))).resolves.toMatchObject({ state: 'unavailable', reason: 'not-active' });
  expect(h.invoke).not.toHaveBeenCalled();
  const reduced = modelHarness();
  const evaluatorBudget = new BeuserCallBudget(limits), fallback = createBeuserModelPort({ ...reduced.ports, independence: 'reduced' }, evaluatorBudget);
  await expect(fallback.evaluate(reduced.ctx, 'a'.repeat(64))).resolves.toMatchObject({ state: 'invoked', receipt: { maker: 'zai', role: 'beuser-evaluator' } });
  expect(reduced.invoke).toHaveBeenCalledOnce();
  expect(evaluatorBudget.remaining()).toMatchObject({ calls: 1, tokens: 50, cost: 0.9 });
  await fallback.evaluate(reduced.ctx, 'a'.repeat(64));
  await expect(fallback.evaluate(reduced.ctx, 'a'.repeat(64))).rejects.toThrow('BEUSER_LIMITS_UNAVAILABLE');
  expect(reduced.invoke).toHaveBeenCalledTimes(2); expect(evaluatorBudget.remaining()).toMatchObject({ calls: 0, tokens: 0 });
  const unknown = modelHarness({});
  await expect(createBeuserModelPort(unknown.ports, new BeuserCallBudget(limits)).evaluate(unknown.ctx, 'a'.repeat(64))).resolves.toMatchObject({ state: 'unavailable', reason: 'maker-unknown' });
  await expect(createBeuserModelPort({ ...unknown.ports, independence: 'reduced' }, new BeuserCallBudget(limits)).evaluate(unknown.ctx, 'a'.repeat(64)))
    .resolves.toMatchObject({ state: 'invoked', receipt: { maker: null, role: 'beuser-evaluator' } });
});
