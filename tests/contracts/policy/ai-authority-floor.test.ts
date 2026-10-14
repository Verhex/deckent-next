import { expect, it } from 'vitest';
import { aiAuthorityFloor, evaluatePolicy, getPolicyVocabulary, type VerifiedPrincipal } from '#domain/index.js';

const human: VerifiedPrincipal = { id: 'owner', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['s'] };
const mcp: VerifiedPrincipal = { ...human, id: 'mcp', issuer: 'host/mcp', assurance: 'workload-verified' };
const legacyMcp: VerifiedPrincipal = { ...mcp, assurance: 'os-user' };
const workload: VerifiedPrincipal = { ...human, id: 'script', issuer: 'ci', assurance: 'workload-verified' };
/** Every route that can widen an AI actor's own (or a controlled principal's) authority, against the vocabulary and administration commands. */
const WIDENING: readonly (readonly [string, string, string, string])[] = [
  ['grants, role bindings, delegation cells, restrictions, SoD, standing grants', 'operation', 'policy.administer', 'execute'],
  ['policy administration compensation', 'operation', 'policy.administer', 'compensate'],
  ['authority document write', 'authority-document', 'policy', 'write'],
  ['authenticator record', 'authenticator', 'local-os', 'register'],
  ['assurance level record', 'approval-assurance', 'core.turn-bound@1', 'activate'],
  ['permission mode', 'permission-mode', 'full-auto', 'set'],
  ['full access', 'permission-mode', 'full-access', 'set'],
  ['backup restore of authority', 'backup', 'set', 'restore'],
  ['secret write', 'secret', 'OPENAI_API_KEY', 'set'],
  ['secret delete', 'secret', 'OPENAI_API_KEY', 'delete'],
  ['secret store switch', 'secret', 'all', 'switch'],
  ['secret read', 'secret', 'OPENAI_API_KEY', 'read'],
  ['secret resolve', 'secret', 'OPENAI_API_KEY', 'resolve'],
  ['identity profile distribution card', 'approval', 'identity-profile', 'decide'],
  ['MCP capability / trust grant card', 'approval', 'policy-mcp-capability', 'decide'],
  ['template upgrade / rollback card', 'approval', 'policy-template-upgrade', 'decide'],
  ['audit checkpoint re-baseline', 'audit', 's', 'rebaseline'],
  ['secret-gate exclusion globs', 'config', 'project:execution.secretGate.allowPatternPaths', 'write'],
  ['secret-gate acknowledged deny paths', 'config', 'global:execution.secretGate.acknowledgedDenyPaths', 'write'],
  ['secret-gate section', 'config', 'project:execution.secretGate', 'write'],
  ['approval assurance producers', 'config', 'project:approvals.assuranceProducers', 'write'],
  ['policy config', 'config', 'project:policy', 'write'],
  ['identity config', 'config', 'global:identity.profile', 'write'],
  ['shell boundary config', 'config', 'project:shell.readOnly', 'write'],
  ['network boundary config', 'config', 'project:network.allow', 'write'],
  ['principal assurance enforcement', 'config', 'project:enforce_principal_assurance', 'write'],
];
const grantAll = (kind: string, principal: VerifiedPrincipal) => ({ id: `all-${kind}`, effect: 'allow' as const, actions: 'all' as const, scopes: 'all' as const,
  principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind, ids: 'all' as const } });
const policyFor = (principal: VerifiedPrincipal) => ({ schemaVersion: 1, revision: 'p', restrictions: [],
  grants: [...new Set(WIDENING.map(row => row[1]))].map(kind => grantAll(kind, principal)) });

it.each(WIDENING)('%s is refused for every AI actor even when a policy cell grants it (%s %s %s)', (_label, kind, id, action) => {
  for (const ai of [mcp, legacyMcp, workload]) {
    expect(aiAuthorityFloor(ai, { kind, id }, action), ai.id).toBe(true);
    expect(evaluatePolicy(policyFor(ai), { principal: ai, scopeId: 's', action, resource: { kind, id } }), ai.id).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  }
  // The same grant works for a human: the refusal is the floor, not a missing grant.
  expect(evaluatePolicy(policyFor(human), { principal: human, scopeId: 's', action, resource: { kind, id } }).decision).toBe('allow');
});

it('every vocabulary action that is not authority-widening stays policy-governed for AI', () => {
  const widening = new Set(WIDENING.map(([, kind, , action]) => `${kind}:${action}`));
  const governed = getPolicyVocabulary().resources.flatMap(resource => resource.actions.map(action => `${resource.kind}:${action}`))
    .filter(cell => !widening.has(cell) && !['backup:restore', 'permission-mode:set'].includes(cell) && !cell.startsWith('secret:'));
  for (const cell of governed) {
    const [kind, action] = cell.split(':') as [string, string];
    expect(aiAuthorityFloor(mcp, { kind, id: 'ordinary-target' }, action), cell).toBe(false);
  }
  expect(aiAuthorityFloor(mcp, { kind: 'audit', id: 's' }, 'verify')).toBe(false);
  expect(aiAuthorityFloor(mcp, { kind: 'approval', id: 'ordinary-uuid' }, 'decide')).toBe(false);
  expect(aiAuthorityFloor(mcp, { kind: 'config', id: 'project:terminal.theme' }, 'write')).toBe(false);
});
