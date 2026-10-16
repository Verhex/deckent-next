import { expect, it } from 'vitest';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, IDENTITY_MAX_LENGTH, firstRunPolicyTemplate, firstRunServiceId, firstRunTemplateAdditions, firstRunTemplateRollback,
  mcpPrincipalRef, namedPersonPolicyAdditions, resolvePolicyBindings, upgradeFirstRunPolicy } from '#domain/index.js';
import { DispatchInventoryPolicyAuthorization, ServicePolicyAuthorization } from '#engine/core/policy/index.js';

// POLICY-V12 (owner 2026-10-16, "Evet, v12 hazırla"; clean-install rehearsal F1/F2): the named installing person inspects the installed scope and
// shuts down exactly this installation's runtime service. No new MCP/AI authority; edited and hand-built policies keep the v11 add-only plan.
const person = { issuer: 'host', subject: 'owner' };
const owner = { id: 'owner', ...person, assurance: 'os-user' as const, scopeIds: ['installation', 'other'] };
const mcp = { ...owner, ...mcpPrincipalRef(person), assurance: 'workload-verified' as const };
const colleague = { ...owner, id: 'colleague', subject: 'colleague' };
const names = { proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' };
const input = { scopeId: 'installation', principal: person, ...names, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
  scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['run_shell'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run' };
const v12ids = ['first-run-scope-inspect', 'first-run-service-shutdown'];
const built = firstRunPolicyTemplate(input);
const v11 = { ...built.policy, revision: 'first-run-template-v11', grants: built.policy.grants.filter(rule => !v12ids.includes(rule.id)) };
const source = (policy: unknown) => ({ async load() { return resolvePolicyBindings(policy, built.bindings); } });
const SERVICE = 'installation-runtime';

it('v12 adds exactly two rules naming the person alone, in the installed scope only, on the installed scope and this installation\'s service id', () => {
  expect(built.version).toBe(12);
  expect(built.policy.grants.filter(rule => v12ids.includes(rule.id))).toEqual([
    { id: 'first-run-scope-inspect', effect: 'allow', actions: ['inspect'], scopes: ['installation'], principals: [person], resource: { kind: 'scope', ids: ['installation'] } },
    { id: 'first-run-service-shutdown', effect: 'allow', actions: ['shutdown'], scopes: ['installation'], principals: [person], resource: { kind: 'service', ids: [SERVICE] } },
  ]);
  // A configured service id of this scope is the one named; the default is deterministic, derived from the scope and within the identity bound.
  expect(firstRunPolicyTemplate({ ...input, serviceId: 'configured' }).policy.grants.find(rule => rule.id === v12ids[1])?.resource).toEqual({ kind: 'service', ids: ['configured'] });
  expect(firstRunServiceId('installation')).toBe(SERVICE);
  const long = 'x'.repeat(IDENTITY_MAX_LENGTH);
  expect(firstRunServiceId(long)).toHaveLength(IDENTITY_MAX_LENGTH); expect(firstRunServiceId(long)).toBe(firstRunServiceId(long));
  expect(() => firstRunServiceId(' bad')).toThrow();
  // No new authority for the MCP actor: a template built for it carries neither rule, and no v12 rule ever names it.
  expect(firstRunPolicyTemplate({ ...input, principal: mcpPrincipalRef(person) }).policy.grants.filter(rule => v12ids.includes(rule.id))).toEqual([]);
  for (const rule of built.policy.grants.filter(rule => v12ids.includes(rule.id))) expect(rule.principals).toEqual([person]);
});

it('F2: v11 denies the owner scope inspection (only the MCP actor had it); v12 allows the owner and keeps every other principal and scope denied', async () => {
  const inventory = (policy: unknown) => new DispatchInventoryPolicyAuthorization(source(policy));
  await expect(inventory(v11).authorize('installation', owner)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(inventory(v11).authorize('installation', mcp)).resolves.toBeUndefined(); // v9 observation, unchanged
  await expect(inventory(built.policy).authorize('installation', owner)).resolves.toBeUndefined();
  await expect(inventory(built.policy).authorize('installation', colleague)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(inventory(built.policy).authorize('other', owner)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it('F1: only the named owner may shut down exactly this service in this scope; the MCP actor, another person, a foreign scope or service id are denied', async () => {
  const service = (policy: unknown) => new ServicePolicyAuthorization(source(policy));
  const target = { scopeId: 'installation', serviceId: SERVICE };
  await expect(service(v11).authorize(target, owner)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(service(built.policy).authorize(target, owner)).resolves.toEqual({ revision: expect.stringContaining('first-run-template-v12'), ruleId: 'first-run-service-shutdown' });
  // `serviceActorSchema` admits the local MCP peer, so this policy decision is its only shutdown gate.
  await expect(service(built.policy).authorize(target, mcp)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(service(built.policy).authorize(target, colleague)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(service(built.policy).authorize({ ...target, scopeId: 'other' }, owner)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(service(built.policy).authorize({ ...target, serviceId: 'another-service' }, owner)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it('exact v11 upgrades to v12 (also naming a configured service id); edited and hand-built policies are not given the v12 rules by any add-only plan', () => {
  expect(upgradeFirstRunPolicy(v11, input)).toEqual({ status: 'upgrade', from: 11, policy: built.policy });
  const configured = firstRunPolicyTemplate({ ...input, serviceId: 'configured' }).policy;
  expect(upgradeFirstRunPolicy(v11, { ...input, serviceId: 'configured' })).toEqual({ status: 'upgrade', from: 11, policy: configured });
  expect(upgradeFirstRunPolicy(built.policy, input)).toEqual({ status: 'current' });
  // Another person's or another scope's exact v11 is not this installation's template.
  expect(upgradeFirstRunPolicy(v11, { ...input, principal: { issuer: 'host', subject: 'colleague' } })).toEqual({ status: 'unavailable', reason: 'not-v4-template' });
  // A hand-edited v11 (one extra rule) is refused by the exact path and the add-only plans never carry a v12 rule (owner 2026-10-16 scope).
  const edited = { ...v11, revision: 'a-edited', grants: [...v11.grants, { id: 'extra', effect: 'allow', actions: ['invoke'], scopes: ['installation'], principals: [person],
    resource: { kind: 'agent-tool', ids: ['fetch_url'] } }] };
  expect(upgradeFirstRunPolicy(edited, input)).toEqual({ status: 'unavailable', reason: 'not-v4-template' });
  const handBuilt = { ...edited, grants: edited.grants.map(rule => rule.id === 'first-run-read-tools' ? { ...rule, id: 'custom-read-tools' } : rule) };
  for (const plan of [firstRunTemplateAdditions(edited, { ...names, person }), namedPersonPolicyAdditions(handBuilt, { ...names, person, scopeId: 'installation' })]) {
    expect(plan.status).not.toBe('unavailable');
    expect(plan.status === 'plan' ? plan.rules.map(rule => rule.id).filter(id => v12ids.includes(id)) : []).toEqual([]);
  }
  // The rollback delta stays v11's: the v12 owner rules are never removed by `policy upgrade --template current --rollback`.
  expect(FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.some(id => v12ids.includes(id))).toBe(false);
  expect(firstRunTemplateRollback(built.policy, person).rules.map(rule => rule.id).some(id => v12ids.includes(id))).toBe(false);
});
