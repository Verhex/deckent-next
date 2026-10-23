import { expect, it } from 'vitest';
import { RECOVERY_ACTIONS, aiAuthorityFloor, evaluatePolicy, getPolicyVocabulary } from '#domain/index.js';

// S6R-3 (lead on s6 Q3): the K-B standing approval is an ordinary owner policy grant on `recovery-action` (resource id = the standing-list
// action). Only a person can hold it: the AI floor refuses it for every AI principal (MCP, auditor, Nervous) whatever a policy grants.
const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [
  { id: 'standing', effect: 'allow', actions: 'all', scopes: 'all', principals: 'all', resource: { kind: 'recovery-action', ids: 'all' } }] };
const principal = (issuer: string, assurance = 'os-user') => ({ id: issuer, issuer, subject: '1000', assurance, scopeIds: ['s'] });

it('advertises recovery-action with the one action `apply`; the catalog itself grants nothing', () => {
  expect(getPolicyVocabulary().resources.find(resource => resource.kind === 'recovery-action')!.actions).toEqual(['apply']);
  expect(evaluatePolicy({ ...policy, grants: [] }, { principal: principal('host'), scopeId: 's', action: 'apply', resource: { kind: 'recovery-action', id: 'stop-orphan' } }).decision).toBe('deny');
});

it.each(RECOVERY_ACTIONS)('a person may hold the standing grant for %s; no AI principal can, whatever is granted', action => {
  const request = (actor: ReturnType<typeof principal>) => ({ principal: actor, scopeId: 's', action: 'apply', resource: { kind: 'recovery-action', id: action } });
  expect(evaluatePolicy(policy, request(principal('host'))).decision).toBe('allow');
  for (const actor of [principal('host/nervous'), principal('host/auditor'), principal('host/mcp'), principal('host', 'workload-verified')]) {
    expect(aiAuthorityFloor(actor, { kind: 'recovery-action', id: action }, 'apply')).toBe(true);
    expect(evaluatePolicy(policy, request(actor)).decision).toBe('deny');
  }
});
