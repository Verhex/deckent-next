import { expect, it } from 'vitest';
import { MEMORY_EVALUATOR_ALLOWED_PAIRS, evaluatePolicy, getPolicyVocabulary, isAiPrincipal, isMemoryDistillerPrincipal, isMemoryEvaluatorPrincipal, isWorkloadPrincipalRef,
  memoryDistillerPrincipal, memoryEvaluatorPrincipal, verifiedPrincipalSchema, type VerifiedPrincipal } from '#domain/index.js';
import { runtimeServiceRequestSchema } from '#engine/index.js';

// S4B-3 (S4B-DESIGN §5 A4/A5, owner S-M3/S-M4 2026-10-23): the memory evaluator is a workload identity only the composition root issues. Its floor
// is the exact (resource kind, action) allow-list V1–V5; the AI memory floor relaxes only for it, only for `verify` and `contest`. `retire` and
// `purge` stay refused for every AI principal, the evaluator included; the distiller still never verifies.
const owner = { issuer: 'host', subject: '1000' };
const evaluator = memoryEvaluatorPrincipal(owner, ['s']);
const distiller = memoryDistillerPrincipal(owner, ['s']);
const everything = { schemaVersion: 1, revision: 'p-all', restrictions: [],
  grants: getPolicyVocabulary().resources.map(resource => ({ id: `all-${resource.kind}`, effect: 'allow', actions: 'all', scopes: 'all', resource: { kind: resource.kind, ids: 'all' },
    principals: [{ issuer: evaluator.issuer, subject: evaluator.subject }, { issuer: distiller.issuer, subject: distiller.subject }, { issuer: 'host/mcp', subject: '1000' }] })) };
const decide = (principal: VerifiedPrincipal, kind: string, action: string, policy: unknown = everything, scopeId = 's') =>
  evaluatePolicy(policy, { principal, scopeId, action, resource: { kind, id: kind === 'config' ? 'project:language' : 'x' } });

it('N3b: is a verified workload principal that is AI, not the distiller; a forged os-user evaluator is still AI; no client channel names it', () => {
  expect(verifiedPrincipalSchema.parse(evaluator)).toEqual(evaluator);
  expect(evaluator).toMatchObject({ issuer: 'host/memory-evaluator', subject: '1000', assurance: 'workload-verified', scopeIds: ['s'] });
  expect(isMemoryEvaluatorPrincipal(evaluator)).toBe(true); expect(isAiPrincipal(evaluator)).toBe(true); expect(isWorkloadPrincipalRef(evaluator)).toBe(true);
  expect(isMemoryDistillerPrincipal(evaluator)).toBe(false); expect(isMemoryEvaluatorPrincipal(distiller)).toBe(false);
  const forged: VerifiedPrincipal = { ...evaluator, assurance: 'os-user' };
  expect(isAiPrincipal(forged)).toBe(true); expect(isMemoryEvaluatorPrincipal(forged)).toBe(true);
  expect(isMemoryEvaluatorPrincipal({ issuer: 'host' })).toBe(false); expect(isMemoryEvaluatorPrincipal({ issuer: 'host/mcp' })).toBe(false);
  expect(runtimeServiceRequestSchema.safeParse({ schemaVersion: 1, requestId: 'r1', operation: 'describeService', input: {}, channel: 'memory-evaluator' }).success).toBe(false);
});

it('N3: the floor allows exactly V1–V5 and refuses every other (kind, action) pair of the vocabulary even when granted', () => {
  expect(MEMORY_EVALUATOR_ALLOWED_PAIRS).toEqual([['memory', 'inspect'], ['memory', 'verify'], ['memory', 'contest'], ['run', 'inspect'], ['model-invocation', 'invoke']]);
  const allowed = new Set(MEMORY_EVALUATOR_ALLOWED_PAIRS.map(([kind, action]) => `${kind}/${action}`));
  let granted = 0, refused = 0;
  for (const { kind, actions } of getPolicyVocabulary().resources) for (const action of actions) {
    const decision = decide(evaluator, kind, action);
    if (allowed.has(`${kind}/${action}`)) { granted++; expect({ kind, action, ...decision }).toMatchObject({ decision: 'allow', reason: 'GRANTED' }); }
    else { refused++; expect({ kind, action, ...decision }).toMatchObject({ kind, action, decision: 'deny', reason: 'AI_NON_DELEGABLE' }); }
  }
  expect(granted).toBe(5); expect(refused).toBeGreaterThan(40);
  // Never propose, retire, purge or read raw worker output; nothing outside the list, whatever is granted.
  for (const [kind, action] of [['memory', 'propose'], ['memory', 'retire'], ['memory', 'purge'], ['attempt', 'read-output'], ['model-invocation', 'inspect-content'],
    ['config', 'write'], ['run', 'future-write']] as const) expect(decide(evaluator, kind, action)).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  // Inside the list a grant still decides, and only in its scopes.
  expect(decide(evaluator, 'memory', 'verify', { ...everything, grants: [] })).toMatchObject({ decision: 'deny', reason: 'NO_GRANT' });
  expect(evaluatePolicy(everything, { principal: evaluator, scopeId: 'other', action: 'verify', resource: { kind: 'memory', id: 'other' } })).toMatchObject({ decision: 'deny', reason: 'SCOPE' });
});

it('A5 amendment: memory verify and contest pass the floor only for the evaluator; every other AI principal stays refused, and retire/purge for all', () => {
  const mcp: VerifiedPrincipal = { id: 'm', issuer: 'host/mcp', subject: '1000', assurance: 'workload-verified', scopeIds: ['s'] };
  const service: VerifiedPrincipal = { id: 'w', issuer: 'host', subject: '1000', assurance: 'workload-verified', scopeIds: ['s'] };
  for (const principal of [mcp, distiller, service]) for (const action of ['verify', 'contest', 'retire', 'purge'])
    expect({ who: principal.issuer, action, ...decide(principal, 'memory', action) }).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  for (const action of ['verify', 'contest']) expect(decide(evaluator, 'memory', action)).toMatchObject({ decision: 'allow' });
  for (const action of ['retire', 'purge']) expect(decide(evaluator, 'memory', action)).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
});
