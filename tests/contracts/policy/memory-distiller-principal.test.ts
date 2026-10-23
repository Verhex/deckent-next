import { expect, it } from 'vitest';
import { MEMORY_DISTILLER_ALLOWED_PAIRS, evaluatePolicy, getPolicyVocabulary, isAiPrincipal, isAuditorPrincipal, isMemoryDistillerPrincipal, memoryDistillerPrincipal,
  verifiedPrincipalSchema, type VerifiedPrincipal } from '#domain/index.js';
import { runtimeServiceRequestSchema } from '#engine/index.js';

// S4B-1 (S4B-DESIGN §5 A1/A3/A10/A11, owner S-M1/S-M2 2026-10-23): the memory distiller is a workload identity only the composition root issues.
// Its floor is an exact (resource kind, action) allow-list D1–D4: whatever a policy grants it, every other pair is refused. Memory purge and contest
// are refused for every AI principal; no AI writes the `memory` configuration (extraction switch, `memory.automation` overlay).
const owner = { issuer: 'host', subject: '1000' };
const distiller = memoryDistillerPrincipal(owner, ['s']);
const everything = { schemaVersion: 1, revision: 'p-all', restrictions: [],
  grants: getPolicyVocabulary().resources.map(resource => ({ id: `all-${resource.kind}`, effect: 'allow', actions: 'all', scopes: 'all', resource: { kind: resource.kind, ids: 'all' },
    principals: [{ issuer: distiller.issuer, subject: distiller.subject }, { issuer: 'host/mcp', subject: '1000' }] })) };

it('N3b: is a verified workload principal that is AI and only the distiller; a forged os-user distiller is still AI', () => {
  expect(verifiedPrincipalSchema.parse(distiller)).toEqual(distiller);
  expect(distiller).toMatchObject({ issuer: 'host/memory-distiller', subject: '1000', assurance: 'workload-verified', scopeIds: ['s'] });
  expect(isMemoryDistillerPrincipal(distiller)).toBe(true); expect(isAiPrincipal(distiller)).toBe(true); expect(isAuditorPrincipal(distiller)).toBe(false);
  const forged: VerifiedPrincipal = { ...distiller, assurance: 'os-user' };
  expect(isAiPrincipal(forged)).toBe(true); expect(isMemoryDistillerPrincipal(forged)).toBe(true);
  expect(isMemoryDistillerPrincipal({ issuer: 'host' })).toBe(false); expect(isMemoryDistillerPrincipal({ issuer: 'host/mcp' })).toBe(false);
  // No client channel names it: the runtime request admits only the MCP channel.
  expect(runtimeServiceRequestSchema.safeParse({ schemaVersion: 1, requestId: 'r1', operation: 'describeService', input: {}, channel: 'memory-distiller' }).success).toBe(false);
});

it('N2: the floor allows exactly D1–D4 and refuses every other (kind, action) pair of the vocabulary even when granted', () => {
  expect(MEMORY_DISTILLER_ALLOWED_PAIRS).toEqual([['memory', 'inspect'], ['memory', 'propose'], ['attempt', 'read-output'], ['run', 'inspect']]);
  const allowed = new Set(MEMORY_DISTILLER_ALLOWED_PAIRS.map(([kind, action]) => `${kind}/${action}`));
  let reads = 0, refused = 0;
  for (const { kind, actions } of getPolicyVocabulary().resources) for (const action of actions) {
    const decision = evaluatePolicy(everything, { principal: distiller, scopeId: 's', action, resource: { kind, id: kind === 'config' ? 'project:language' : 'x' } });
    if (allowed.has(`${kind}/${action}`)) { reads++; expect({ kind, action, ...decision }).toMatchObject({ decision: 'allow', reason: 'GRANTED' }); }
    else { refused++; expect({ kind, action, ...decision }).toMatchObject({ kind, action, decision: 'deny', reason: 'AI_NON_DELEGABLE' }); }
  }
  expect(reads).toBe(4); expect(refused).toBeGreaterThan(40);
  for (const [kind, action] of [['memory', 'verify'], ['memory', 'retire'], ['memory', 'purge'], ['attempt', 'execute'], ['config', 'write'], ['run', 'future-write']] as const) {
    expect(evaluatePolicy(everything, { principal: distiller, scopeId: 's', action, resource: { kind, id: 'x' } })).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  }
  // A grant is still needed inside the allow-list, and nothing outside its scopes.
  expect(evaluatePolicy({ ...everything, grants: [] }, { principal: distiller, scopeId: 's', action: 'propose', resource: { kind: 'memory', id: 's' } })).toMatchObject({ decision: 'deny', reason: 'NO_GRANT' });
  expect(evaluatePolicy(everything, { principal: distiller, scopeId: 'other', action: 'propose', resource: { kind: 'memory', id: 'other' } })).toMatchObject({ decision: 'deny', reason: 'SCOPE' });
});

it('A11/N27: memory purge and contest are vocabulary actions refused for every AI principal (the MCP actor included)', () => {
  expect(getPolicyVocabulary().resources.find(resource => resource.kind === 'memory')?.actions).toEqual(['inspect', 'propose', 'verify', 'retire', 'contest', 'purge']);
  const mcp = { id: 'm', issuer: 'host/mcp', subject: '1000', assurance: 'workload-verified' as const, scopeIds: ['s'] };
  for (const action of ['purge', 'contest', 'verify', 'retire']) {
    expect(evaluatePolicy(everything, { principal: mcp, scopeId: 's', action, resource: { kind: 'memory', id: 's' } })).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  }
  expect(evaluatePolicy(everything, { principal: mcp, scopeId: 's', action: 'inspect', resource: { kind: 'memory', id: 's' } })).toMatchObject({ decision: 'allow' });
});

it('A10/N15: the memory automation configuration is protected (no AI switches extraction or writes the registry overlay)', () => {
  const mcp = { id: 'm', issuer: 'host/mcp', subject: '1000', assurance: 'workload-verified' as const, scopeIds: ['s'] };
  const write = (key: string) => evaluatePolicy(everything, { principal: mcp, scopeId: 's', action: 'write', resource: { kind: 'config', id: `project:${key}` } });
  for (const key of ['memory', 'memory.automation', 'memoryAutomation', 'memoryAutomation.extraction', 'memoryAutomation.extraction.mode', 'memoryAutomation.overlay',
    'memoryAutomation.overlay.workClasses[0].extraction']) expect({ key, ...write(key) }).toMatchObject({ key, decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  expect(write('language')).toMatchObject({ decision: 'allow' });
});
