import { expect, it } from 'vitest';
import { getDecisionSteps, getPolicyVocabulary, installationOwnerPermissions, resolvePolicyBindings, mcpPrincipalRef, explicitDecisionGrant, type VerifiedPrincipal } from '#domain/index.js';
import { DecisionDelegations } from '#engine/index.js';

const human: VerifiedPrincipal = { id: 'owner', issuer: 'host', subject: 'person', assurance: 'os-user', scopeIds: ['scope'] };
function fixture() {
  let policy = resolvePolicyBindings({ schemaVersion: 2, revision: 'p', grants: [], restrictions: [], separationOfDuties: [],
    roles: [{ id: 'owner', permissions: installationOwnerPermissions(getPolicyVocabulary().resources.map(r => r.kind)) }] },
  { schemaVersion: 2, revision: 'b', modes: [], bindings: [{ id: 'owner', principals: [{ issuer: human.issuer, subject: human.subject }], roles: ['owner'], scopes: 'all' }] });
  const commands: unknown[] = [];
  const app = (interactive = true) => new DecisionDelegations({ policy: { load: async () => policy },
    administration: { submit: async (command: unknown) => { commands.push(command); return { status: 'settled' } as never; } },
    approve: async () => { throw Error('unexpected'); } }, async () => interactive);
  const input = () => ({ schemaVersion: 1 as const, scopeId: 'scope', step: 'run-resume', actor: 'mcp' as const, action: 'grant' as const, expectedRevision: policy.revision });
  return { app, input, commands, get policy() { return policy; }, set policy(value) { policy = value; } };
}
it('negative first: AI actors cannot grant or revoke, even legacy os-user MCP; noninteractive humans cannot change policy', async () => {
  const f = fixture();
  for (const actor of [{ ...human, ...mcpPrincipalRef(human) }, { ...human, assurance: 'workload-verified' as const }, { ...human, assurance: 'token-verified' as const }])
    for (const action of ['grant', 'revoke'] as const) await expect(f.app().change({ ...f.input(), action }, actor)).rejects.toMatchObject({ code: 'AI_AUTHORITY_NON_DELEGABLE' });
  await expect(f.app(false).change(f.input(), human)).rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
  expect(f.commands).toEqual([]);
});
it('floor/unknown steps, protected approval ids, stale revisions and foreign scopes fail before opening an authority card', async () => {
  const f = fixture();
  for (const step of ['policy-administer', 'secret-read', 'permission-mode-set', 'unknown'])
    await expect(f.app().change({ ...f.input(), step }, human)).rejects.toMatchObject({ code: 'POLICY_DELEGATION_STEP_INVALID' });
  await expect(f.app().change({ ...f.input(), step: 'approval-decide', resourceId: 'policy-mcp-capability' }, human)).rejects.toMatchObject({ code: 'AI_AUTHORITY_NON_DELEGABLE' });
  await expect(f.app().change({ ...f.input(), expectedRevision: 'old' }, human)).rejects.toMatchObject({ code: 'POLICY_DELEGATION_CONFLICT' });
  await expect(f.app().change({ ...f.input(), scopeId: 'foreign' }, human)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.commands).toEqual([]);
});
it('one inventory lists effective cells and makes only the selected named actor/action/scope/resource grant through policy.administer', async () => {
  const f = fixture(), view = await f.app().inspect({ schemaVersion: 1, scopeId: 'scope', resourceId: 'run-1' }, human);
  expect(view.steps.map(s => s.step.id)).toEqual(getDecisionSteps().map(s => s.id));
  expect(view.steps.every(s => s.managed === 'none' && s.effective === 'denied')).toBe(true);
  const result = await f.app().change({ ...f.input(), resourceId: 'run-1' }, human);
  expect(result.status).toBe('applied');
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]).toMatchObject({ operation: { id: 'policy.administer', version: 1 }, expectedVersion: f.policy.revision,
    input: { changes: [{ kind: 'grant.add', grant: { principals: [mcpPrincipalRef(human)], actions: ['resume'], scopes: ['scope'], resource: { kind: 'run-decision', ids: ['run-1'] } } }] } });
  const grant = (f.commands[0] as { input: { changes: { grant: object }[] } }).input.changes[0]!.grant;
  f.policy = { ...f.policy, grants: [grant, { id: 'observe', effect: 'allow', principals: [mcpPrincipalRef(human)], scopes: ['scope'], actions: ['inspect'], resource: { kind: 'scope', ids: ['scope'] } }] } as typeof f.policy;
  const ai = { ...human, ...mcpPrincipalRef(human) };
  expect(explicitDecisionGrant(f.policy, ai, 'scope', 'run-decision', 'run-1', 'resume')).toBeTruthy();
  expect(explicitDecisionGrant(f.policy, ai, 'scope', 'run-decision', 'run-2', 'resume')).toBeNull();
  expect((await f.app().inspect({ schemaVersion: 1, scopeId: 'scope', resourceId: 'run-1' }, ai)).steps[0]).toMatchObject({ managed: 'granted', effective: 'allowed' });
  expect((await f.app().change({ ...f.input(), resourceId: 'run-1', action: 'revoke' }, human)).status).toBe('applied');
  expect(f.commands[1]).toMatchObject({ input: { changes: [{ kind: 'grant.remove' }] } });
});
it('listing preserves custom/role authority and does not treat wildcard actor/action rules as a delegated step', async () => {
  const f = fixture(), custom = { id: 'custom', effect: 'allow' as const, principals: [mcpPrincipalRef(human)], scopes: ['scope'],
    actions: ['resume'], resource: { kind: 'run-decision', ids: 'all' as const } };
  const query = { schemaVersion: 1 as const, scopeId: 'scope' };
  f.policy = { ...f.policy, grants: [custom] };
  expect((await f.app().inspect(query, human)).steps[0]).toMatchObject({ managed: 'none', effective: 'allowed' });
  expect((await f.app().change({ ...f.input(), action: 'revoke' }, human)).status).toBe('current');
  expect(f.commands).toEqual([]);
  f.policy = { ...f.policy, grants: [{ ...custom, actions: 'all' }] };
  expect((await f.app().inspect(query, human)).steps[0]?.effective).toBe('denied');
  f.policy = { ...f.policy, grants: [{ ...custom, principals: 'all' }] };
  expect((await f.app().inspect(query, human)).steps[0]?.effective).toBe('denied');
  f.policy = { ...f.policy, grants: [custom], restrictions: [{ id: 'deny', principals: 'all', scopes: ['scope'], actions: ['resume'], resource: { kind: 'run-decision', ids: ['r'] } }] };
  expect((await f.app().inspect(query, human)).steps[0]?.effective).toBe('denied');
  expect((await f.app().inspect({ ...query, resourceId: 'r' }, human)).steps[0]?.effective).toBe('denied');
  expect((await f.app().inspect({ ...query, resourceId: 'other' }, human)).steps[0]?.effective).toBe('allowed');
});
