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
const names = { proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer', executionEnvironmentIds: ['docker'] };
const input = { scopeId: 'installation', principal: person, ...names, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
  scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['run_shell'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run' };
const v12ids = ['first-run-scope-inspect', 'first-run-service-shutdown'];
// I-POL (alpha.48): the current template is v13, an add-only delta over v12 (FIRST_RUN_CURRENT_UPGRADE_RULE_IDS); v12 is the current one without it.
const current = firstRunPolicyTemplate(input), v13ids: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
const built = { version: 12, bindings: current.bindings, policy: { ...current.policy, revision: 'first-run-template-v12', grants: current.policy.grants.filter(rule => !v13ids.includes(rule.id)) } };
const v11 = { ...built.policy, revision: 'first-run-template-v11', grants: built.policy.grants.filter(rule => !v12ids.includes(rule.id)) };
const source = (policy: unknown) => ({ async load() { return resolvePolicyBindings(policy, built.bindings); } });
const SERVICE = 'installation-runtime';

it('v12 adds exactly two rules naming the person alone, in the installed scope only, on the installed scope and this installation\'s service id', () => {
  expect(current.version).toBe(13); // the v12 rules below are unchanged inside v13
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

it('exact v11 upgrades to v12 (also naming a configured service id); edited and hand-built v11 policies get exactly the two rules add-only (option A)', () => {
  expect(upgradeFirstRunPolicy(v11, input)).toEqual({ status: 'upgrade', from: 11, policy: current.policy });
  const configured = firstRunPolicyTemplate({ ...input, serviceId: 'configured' }).policy;
  expect(upgradeFirstRunPolicy(v11, { ...input, serviceId: 'configured' })).toEqual({ status: 'upgrade', from: 11, policy: configured });
  expect(upgradeFirstRunPolicy(built.policy, input)).toEqual({ status: 'upgrade', from: 12, policy: current.policy });
  expect(upgradeFirstRunPolicy(current.policy, input)).toEqual({ status: 'current' });
  // Another person's or another scope's exact v11 is not this installation's template.
  expect(upgradeFirstRunPolicy(v11, { ...input, principal: { issuer: 'host', subject: 'colleague' } })).toEqual({ status: 'unavailable', reason: 'not-v4-template' });
  // A hand-edited v11 (one extra rule) is refused by the exact path; the add-only plans (owner 2026-10-16 option A) add exactly the two rules.
  const edited = { ...v11, revision: 'a-edited', grants: [...v11.grants, { id: 'extra', effect: 'allow', actions: ['invoke'], scopes: ['installation'], principals: [person],
    resource: { kind: 'agent-tool', ids: ['fetch_url'] } }] };
  expect(upgradeFirstRunPolicy(edited, input)).toEqual({ status: 'unavailable', reason: 'not-v4-template' });
  const handBuilt = { ...edited, grants: edited.grants.map(rule => rule.id === 'first-run-read-tools' ? { ...rule, id: 'custom-read-tools' } : rule) };
  const v12rules = built.policy.grants.filter(rule => v12ids.includes(rule.id));
  for (const [plan, current] of [[firstRunTemplateAdditions(edited, { ...names, person }), edited], [namedPersonPolicyAdditions(handBuilt, { ...names, person, scopeId: 'installation' }), handBuilt]] as const) {
    expect(plan.status).toBe('plan'); if (plan.status !== 'plan') throw new Error('missing v12 plan');
    expect(plan.rules.filter(rule => !v13ids.includes(rule.id))).toEqual(v12rules); expect(plan.conflicts).toEqual([]);
    expect(plan.change.changes.every(change => change.kind === 'grant.add')).toBe(true);
    // Applied, a second plan is current; a configured service id is the one named.
    const applied = { ...current, grants: [...current.grants, ...plan.rules] };
    expect(firstRunTemplateAdditions(applied, { ...names, person }).status === 'unavailable' ? namedPersonPolicyAdditions(applied, { ...names, person, scopeId: 'installation' }).status
      : firstRunTemplateAdditions(applied, { ...names, person }).status).toBe('current');
  }
  const named = firstRunTemplateAdditions(edited, { ...names, person, serviceId: 'configured' });
  expect(named.status === 'plan' ? named.rules.find(rule => rule.id === v12ids[1])?.resource : null).toEqual({ kind: 'service', ids: ['configured'] });
  // Never for the MCP actor or a person the policy does not name; a rule that already covers the service stop is not duplicated.
  expect(firstRunTemplateAdditions(edited, { ...names, person: mcpPrincipalRef(person) })).toEqual({ status: 'unavailable', reason: 'not-this-person' });
  expect(namedPersonPolicyAdditions(handBuilt, { ...names, person: { issuer: 'host', subject: 'colleague' }, scopeId: 'installation' })).toEqual({ status: 'unavailable', reason: 'person-not-named' });
  const covered = { ...edited, grants: [...edited.grants, { id: 'own-stop', effect: 'allow', actions: ['shutdown'], scopes: ['installation'], principals: [person], resource: { kind: 'service', ids: 'all' } }] };
  const partial = firstRunTemplateAdditions(covered, { ...names, person });
  expect(partial.status === 'plan' ? partial.rules.map(rule => rule.id).filter(id => !v13ids.includes(id)) : []).toEqual([v12ids[0]]);
  // The rollback delta (v13's since I-POL) never holds the v12 owner rules: `policy upgrade --template current --rollback` never removes them.
  expect(FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.some(id => v12ids.includes(id))).toBe(false);
  expect(firstRunTemplateRollback(current.policy, person, undefined, names).rules.map(rule => rule.id).some(id => v12ids.includes(id))).toBe(false);
});
