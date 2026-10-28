import { expect, it } from 'vitest';
import { beuserEvaluatorPrincipalRef, isAiPrincipal, isWorkloadPrincipalRef, verifiedPrincipalSchema } from '#domain/core/principal/index.js';
import { aiAuthorityFloor, BEUSER_EVALUATOR_ALLOWED_PAIRS, evaluatePolicy, protectedConfigKey } from '#domain/core/policy/index.js';
import { beuserBindingSchema } from '#domain/core/beuser/index.js';
import { assertBeuserAccess, beuserSurfaceCommandSchema, pinBeuserLimits, pinBeuserWalkerSummary, type BeuserContext } from '#engine/core/beuser-contract/index.js';
import { CORE_MODEL_ROLES, mergeModelRoleRegistries, decideRoleModel, roleModelKey, independentMakerRows } from '#domain/core/provider-catalog/index.js';

const owner = { issuer: 'local', subject: 'person' }, ref = beuserEvaluatorPrincipalRef(owner);
const principal = verifiedPrincipalSchema.parse({ id: 'evaluator', ...ref, assurance: 'workload-verified', scopeIds: ['scope'] });
const limits = { schemaVersion: 1, revision: 'test-policy', source: 'fixture', provisional: true, maxSteps: 25, maxWallMs: 10000,
  maxWaitMs: 1000, maxCalls: 10, maxTokens: 1000, maxCost: 1, currency: 'USD', maxReruns: 1, maxTranscriptBytes: 10000,
  maxArtifactBytes: 10000, cleanupDeadlineMs: 1000, criticalRepetitions: 1 };
const binding = beuserBindingSchema.parse({ schemaVersion: 1, identity: { scopeId: 'scope', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 },
  candidate: { adapter: 'erp', version: 'record-v1', evidenceRef: 'subject', stateDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) },
  candidateDigest: 'c'.repeat(64), personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64),
  realmId: 'realm', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'transcript' });
const context: BeuserContext = { binding, principal, limits: pinBeuserLimits(limits), signal: new AbortController().signal };

it('transport identity remains a workload and AI even with forged os-user assurance', () => {
  expect(ref).toEqual({ issuer: 'local/beuser-evaluator', subject: 'person' });
  expect(isWorkloadPrincipalRef(ref)).toBe(true);
  expect(isAiPrincipal({ ...ref, assurance: 'os-user' })).toBe(true);
  expect(isWorkloadPrincipalRef(owner)).toBe(false);
});

it('the ceiling refuses authority, approvals, secrets, weakening, adoption and future actions despite explicit grants', () => {
  const prohibited = [['approval', 'decide'], ['operation', 'execute'], ['secret', 'read'], ['config', 'write'],
    ['beuser-journey', 'weaken'], ['attempt', 'adopt-integration'], ['run', 'create'], ['beuser-sandbox', 'future-action']];
  for (const actor of [principal, { ...principal, assurance: 'os-user' }]) for (const [kind, action] of prohibited) {
    const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [{ id: 'explicit-grant', principals: [ref], scopes: 'all',
      actions: 'all', resource: { kind, ids: 'all' }, effect: 'allow' }] };
    expect(evaluatePolicy(policy, { principal: actor, scopeId: 'scope', resource: { kind, id: 'target' }, action })).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  }
  for (const [kind, action] of BEUSER_EVALUATOR_ALLOWED_PAIRS) expect(aiAuthorityFloor(principal, { kind, id: 'target' }, action)).toBe(false);
  expect(protectedConfigKey('beuser.limits.maxSteps')).toBe(true);
});

it('an allowed pair still needs a real scope grant', () => {
  expect(evaluatePolicy({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [] },
    { principal, scopeId: 'scope', resource: { kind: 'attempt', id: 'attempt' }, action: 'evaluate' })).toMatchObject({ decision: 'deny', reason: 'NO_GRANT' });
});

it('own resources work and every changed Attempt, scope, nonce, transcript or candidate is refused before an effect', () => {
  const resource = { kind: 'attempt', id: 'attempt' };
  expect(() => assertBeuserAccess(context, binding, principal, resource, 'evaluate')).not.toThrow();
  const mutations = [ { ...binding, identity: { ...binding.identity, scopeId: 'foreign' } },
    { ...binding, identity: { ...binding.identity, generation: 2 } }, { ...binding, identity: { ...binding.identity, attemptId: 'foreign' } },
    { ...binding, nonce: '22345678-1234-4234-8234-123456789abc' }, { ...binding, transcriptId: 'foreign' },
    { ...binding, candidate: { ...binding.candidate, version: 'changed' } } ];
  let effects = 0;
  for (const changed of mutations) expect(() => { assertBeuserAccess(context, changed, principal, resource, 'evaluate'); effects++; }).toThrow('BEUSER_TARGET_NOT_SANDBOX');
  expect(() => { assertBeuserAccess(context, binding, { ...principal, assurance: 'os-user' }, resource, 'evaluate'); effects++; }).toThrow('BEUSER_TARGET_NOT_SANDBOX');
  expect(() => { assertBeuserAccess(context, binding, principal, { kind: 'run', id: 'foreign' }, 'inspect'); effects++; }).toThrow('BEUSER_TARGET_NOT_SANDBOX');
  expect(() => { assertBeuserAccess(context, binding, principal, { kind: 'beuser-transcript', id: 'foreign' }, 'inspect'); effects++; }).toThrow('BEUSER_TARGET_NOT_SANDBOX');
  const cancelled = new AbortController(); cancelled.abort();
  expect(() => { assertBeuserAccess({ ...context, signal: cancelled.signal }, binding, principal, resource, 'evaluate'); effects++; }).toThrow();
  expect(effects).toBe(0);
});

it('wire schemas reject principal, path, verdict, argv and leaked rubric injection', () => {
  const command = { schemaVersion: 1, binding, action: { kind: 'look' } };
  expect(beuserSurfaceCommandSchema.safeParse(command).success).toBe(true);
  for (const extra of [{ principal }, { path: '/foreign' }, { verdict: 'GREEN' }, { rubric: { secret: true } }]) {
    expect(beuserSurfaceCommandSchema.safeParse({ ...command, ...extra }).success).toBe(false);
  }
  expect(beuserSurfaceCommandSchema.safeParse({ ...command, action: { kind: 'argv', args: ['approval', 'decide'] } }).success).toBe(false);
});

it('limit admission has no missing, infinite or inconsistent fallback', () => {
  for (const value of [undefined, {}, { ...limits, maxCalls: Infinity }, { ...limits, maxCost: 0 }, { ...limits, maxWaitMs: 20000 }]) {
    expect(() => pinBeuserLimits(value)).toThrow('BEUSER_LIMITS_UNAVAILABLE');
  }
  expect(Object.isFrozen(pinBeuserLimits(limits))).toBe(true);
});

it('walker summary pins persona behaviour and product locale without exposing the sealed rubric', () => {
  const summary = { schemaVersion: 1, personaId: 'persona', journeyId: 'journey', language: 'tr', role: 'buyer', goals: ['purchase'],
    knowledgeBoundary: ['no internal terminology'], accessibility: ['screen-reader'], initialKnowledge: ['purchase request'], goal: 'request goods',
    competency: { computer: 1, domain: 4, product: 0 }, preferences: ['plain language'], riskAttitude: 'cautious', surface: 'terminal',
    organizationContext: { mode: 'enterprise' }, patience: { maxSteps: 25, maxWaitMs: 1000 }, attentionMs: 10000 };
  expect(pinBeuserWalkerSummary(summary)).toEqual(summary);
  expect(Object.isFrozen(pinBeuserWalkerSummary(summary).patience)).toBe(true);
  expect(() => pinBeuserWalkerSummary({ ...summary, language: 'unsupported' })).toThrow('BEUSER_INPUT_INVALID');
  expect(() => pinBeuserWalkerSummary({ ...summary, rubric: { expectedFailure: true } })).toThrow();
  expect(() => pinBeuserWalkerSummary({ ...summary, competency: { ...summary.competency, computer: 5 } })).toThrow();
});

it('new model roles grant neither activation nor maker independence', () => {
  const policy = mergeModelRoleRegistries(CORE_MODEL_ROLES, []);
  for (const role of ['beuser-walker', 'beuser-evaluator']) {
    expect(policy.roles.find(row => row.id === role)?.minimumTier).toBe('frontier');
    const row = policy.models.find(model => model.roles.includes(role))!;
    expect(decideRoleModel(policy, role, row, { today: '2026-10-29', active: new Set() })).toEqual({ state: 'refused', reason: 'not-active' });
    expect(decideRoleModel(policy, role, { channelId: 'unknown', modelId: 'unknown' }, { today: '2026-10-29', active: new Set([roleModelKey(row)]) })).toEqual({ state: 'refused', reason: 'model-unknown' });
    expect(independentMakerRows([row], () => null, ['maker'])).toEqual([]);
    expect(independentMakerRows([row], () => 'maker', ['maker'])).toEqual([]);
  }
});
