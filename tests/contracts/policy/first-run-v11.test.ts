import { expect, it } from 'vitest';
import { firstRunPolicyTemplate, firstRunTemplateAdditions, firstRunTemplateRollback, namedPersonPolicyAdditions, mcpPrincipalRef,
  FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, resolvePolicyBindings, upgradeFirstRunPolicy, type PolicyGrant } from '#domain/index.js';
import { DispatchPolicyAuthorization, PoolControlPolicyAuthorization, WorkTargetPolicyAuthorization, workTargetAttemptAuthorization } from '#engine/core/policy/index.js';

const person = { issuer: 'host', subject: 'owner' };
const principal = { id: 'owner', ...person, assurance: 'os-user' as const, scopeIds: ['installation', 'other'] };
const names = { proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' };
const input = { scopeId: 'installation', principal: person, ...names, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
  scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['run_shell'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run' };
const ids = ['first-run-quota-release', 'first-run-integration', 'first-run-work-target-adopt'];
const built = firstRunPolicyTemplate(input);
const v10 = { ...built.policy, revision: 'first-run-template-v10', grants: built.policy.grants.filter(rule => !ids.includes(rule.id)) };
const identity = { scopeId: 'installation', runId: 'run', taskId: 'task', attemptId: 'attempt', generation: 1 };
const source = (policy: unknown) => ({ async load() { return resolvePolicyBindings(policy, built.bindings); } });

it('migrates exact v10 to v11 and plans the same named delta additively for first-run and hand-built policies', () => {
  expect(upgradeFirstRunPolicy(v10, input)).toEqual({ status: 'upgrade', from: 10, policy: built.policy });
  expect(FIRST_RUN_CURRENT_UPGRADE_RULE_IDS).toEqual(ids);
  const custom = { ...v10, revision: 'custom', grants: v10.grants.filter(rule => rule.id !== 'first-run-read-tools') };
  const first = firstRunTemplateAdditions(v10, { ...names, person });
  const hand = namedPersonPolicyAdditions(custom, { ...names, person, scopeId: 'installation' });
  for (const plan of [first, hand]) {
    expect(plan.status).toBe('plan'); if (plan.status !== 'plan') throw new Error('missing v11 delta');
    expect(plan.rules.map(rule => rule.id)).toEqual(ids);
    expect(plan.change.changes.every(change => change.kind === 'grant.add')).toBe(true);
    expect(plan.rules[0]).toMatchObject({ actions: ['release-quota'], scopes: 'all', principals: [person], resource: { kind: 'pool', ids: 'all' } });
    for (const rule of plan.rules.slice(1)) expect(rule).toMatchObject({ scopes: ['installation'], principals: [person], resource: { ids: 'all' } });
  }
});

it.each(['prepare-integration', 'deliver-integration', 'adopt-integration', 'rollback-integration'] as const)('%s is denied before v11, allowed after, and denied to MCP/other scope or a missing target grant', async action => {
  const attempts = (policy: unknown) => new DispatchPolicyAuthorization(source(policy));
  await expect(attempts(v10).authorizeIdentity(action, identity, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  const gate = workTargetAttemptAuthorization(attempts(built.policy), source(built.policy), 'configured-target');
  await expect(gate.authorizeIdentity(action, identity, principal)).resolves.toBeUndefined();
  await expect(gate.authorizeIdentity(action, identity, { ...principal, ...mcpPrincipalRef(person) })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(gate.authorizeIdentity(action, { ...identity, scopeId: 'other' }, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  const targetRule = action === 'adopt-integration' || action === 'rollback-integration' ? 'first-run-work-target-adopt' : 'first-run-work-targets';
  const missing = { ...built.policy, grants: built.policy.grants.filter(rule => rule.id !== targetRule) };
  await expect(workTargetAttemptAuthorization(attempts(missing), source(missing), 'configured-target').authorizeIdentity(action, identity, principal))
    .rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it('quota release uses installation authority independently of resume; adoption still requires its own target authority', async () => {
  const pool = new PoolControlPolicyAuthorization(source(built.policy));
  expect(await pool.decide('release-quota', 'p', 'installation', principal)).toMatchObject({ effect: 'allow', ruleId: ids[0] });
  for (const action of ['hold', 'resume', 'set-capacity'] as const) expect(await pool.decide(action, 'p', 'installation', principal)).toMatchObject({ effect: 'deny' });
  expect(await pool.decide('release-quota', 'p', 'installation', { ...principal, ...mcpPrincipalRef(person) })).toMatchObject({ effect: 'deny' });
  const scoped = { ...built.policy, grants: built.policy.grants.map(rule => rule.id === ids[0] ? { ...rule, scopes: ['installation'] } : rule) };
  expect(await new PoolControlPolicyAuthorization(source(scoped)).decide('release-quota', 'p', 'installation', principal)).toMatchObject({ effect: 'deny' });
  const deniedElsewhere = { ...built.policy, restrictions: [{ id: 'company-deny', principals: [person], scopes: ['other'], actions: ['release-quota'], resource: { kind: 'pool', ids: ['p'] } }] };
  expect(await new PoolControlPolicyAuthorization(source(deniedElsewhere)).decide('release-quota', 'p', 'installation', principal)).toMatchObject({ effect: 'deny' });
  await expect(new WorkTargetPolicyAuthorization(source(v10)).authorize('adopt', 'target', 'installation', principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it('preserves customized v11 ids and existing coverage; only content-equal v11 rules are rollback candidates', () => {
  const changed: PolicyGrant = { ...built.policy.grants.find(rule => rule.id === ids[1])!, actions: ['prepare-integration'] };
  const custom = { ...v10, grants: [...v10.grants, changed, { ...built.policy.grants.find(rule => rule.id === ids[0])!, id: 'custom-quota' }] };
  const plan = firstRunTemplateAdditions(custom, { ...names, person });
  expect(plan).toMatchObject({ status: 'plan', conflicts: [ids[1]] });
  if (plan.status !== 'plan') throw new Error('missing v11 plan');
  expect(plan.rules.map(rule => rule.id)).toEqual([ids[2]]);
  const rollback = firstRunTemplateRollback({ ...built.policy, grants: built.policy.grants.map(rule => rule.id === changed.id ? changed : rule) }, person);
  expect(rollback.rules.map(rule => rule.id)).toEqual([ids[0], ids[2]]); expect(rollback.conflicts).toEqual([ids[1]]);
  expect(firstRunTemplateRollback(built.policy, mcpPrincipalRef(person))).toEqual({ rules: [], conflicts: [] });
  expect(firstRunPolicyTemplate({ ...input, principal: mcpPrincipalRef(person) }).policy.grants.filter(rule => ids.includes(rule.id))).toEqual([]);
});
