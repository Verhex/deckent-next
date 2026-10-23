import { expect, it } from 'vitest';
import { auditorPrincipal, AUDITOR_READ_ACTIONS, evaluatePolicy, getPolicyVocabulary, isAiPrincipal, isAuditorPrincipal, verifiedPrincipalSchema, type VerifiedPrincipal } from '#domain/index.js';
import { runtimeServiceRequestSchema } from '#engine/index.js';

// S5 (AUDITOR-MODEL 2026-10-17, owner Q4): the auditor is a read-only workload identity issued in the composition root (never a channel a
// client can name); no new principal kind before OG5. Whatever a policy grants it, every action outside the read set is refused.
const owner = { issuer: 'host', subject: '1000' };
const auditor = auditorPrincipal(owner, ['s']);
/** A policy that grants everything to everyone, auditor included (the worst company data). */
const everything = { schemaVersion: 1, revision: 'p-all', restrictions: [],
  grants: getPolicyVocabulary().resources.map(resource => ({ id: `all-${resource.kind}`, effect: 'allow', actions: 'all', scopes: 'all', resource: { kind: resource.kind, ids: 'all' },
    principals: [{ issuer: auditor.issuer, subject: auditor.subject }] })) };

it('issues a verified workload principal that is AI and auditor, distinct from the owner and the MCP actor', () => {
  expect(verifiedPrincipalSchema.parse(auditor)).toEqual(auditor);
  expect(auditor).toMatchObject({ issuer: 'host/auditor', subject: '1000', assurance: 'workload-verified', scopeIds: ['s'] });
  expect(isAuditorPrincipal(auditor)).toBe(true);
  expect(isAiPrincipal(auditor)).toBe(true);
  // Transport identity dominates assurance: a forged os-user auditor is still the auditor and still AI.
  const forged: VerifiedPrincipal = { ...auditor, assurance: 'os-user' };
  expect(isAuditorPrincipal(forged)).toBe(true); expect(isAiPrincipal(forged)).toBe(true);
  expect(isAuditorPrincipal({ issuer: 'host' })).toBe(false); expect(isAuditorPrincipal({ issuer: 'host/mcp' })).toBe(false);
});

it('refuses every non-read action of the whole vocabulary even when granted, and keeps reads policy-governed', () => {
  expect(AUDITOR_READ_ACTIONS).toEqual(['inspect', 'list', 'verify']);
  let reads = 0, writes = 0;
  for (const { kind, actions } of getPolicyVocabulary().resources) for (const action of actions) {
    const decision = evaluatePolicy(everything, { principal: auditor, scopeId: 's', action, resource: { kind, id: kind === 'config' ? 'project:language' : 'x' } });
    if ((AUDITOR_READ_ACTIONS as readonly string[]).includes(action) && kind !== 'secret') { reads++; expect(decision).toMatchObject({ decision: 'allow', reason: 'GRANTED' }); }
    else { writes++; expect({ kind, action, ...decision }).toMatchObject({ kind, action, decision: 'deny', reason: 'AI_NON_DELEGABLE' }); }
  }
  expect(reads).toBeGreaterThan(0); expect(writes).toBeGreaterThan(reads);
  // An action outside the vocabulary (an extension's future write) is refused too; a read still needs its grant.
  expect(evaluatePolicy(everything, { principal: auditor, scopeId: 's', action: 'future-write', resource: { kind: 'run', id: 'x' } })).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  expect(evaluatePolicy({ ...everything, grants: [] }, { principal: auditor, scopeId: 's', action: 'inspect', resource: { kind: 'run', id: 'x' } })).toMatchObject({ decision: 'deny', reason: 'NO_GRANT' });
  // Outside its scopes nothing is visible.
  expect(evaluatePolicy(everything, { principal: auditor, scopeId: 'other', action: 'inspect', resource: { kind: 'run', id: 'x' } })).toMatchObject({ decision: 'deny', reason: 'SCOPE' });
});

it('cannot be selected from a client channel: the runtime request admits only the MCP channel', () => {
  const request = { schemaVersion: 1, requestId: 'r1', operation: 'describeService', input: {} };
  expect(runtimeServiceRequestSchema.safeParse({ ...request, channel: 'auditor' }).success).toBe(false);
});
