import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, FIRST_RUN_UPGRADE_RULE_IDS, evaluatePolicy, firstRunPolicyTemplate, firstRunTemplateAdditions, firstRunTemplateRollback,
  getPolicyVocabulary, matchFirstRunPolicyTemplate, mcpPrincipalRef, namedPersonPolicyAdditions, resolvePolicyBindings, upgradeFirstRunPolicy, type PolicyGrant } from '#domain/index.js';
import { FIRST_RUN_EXECUTION_ENVIRONMENT_IDS, FIRST_RUN_TOOL_NAMES, PoolControlPolicyAuthorization } from '#engine/index.js';
import { DecisionPolicyAuthorization } from '#engine/core/decision/index.js';

// I-POL (alpha.48, owner A48-D3 + MON-NAMES + CA-1 + C3, 2026-10-19): one bump v12 → v13 with seven add-only rules. The named installing person
// (the founding admin of every identity profile: the template does not depend on the profile) gets six; the MCP actor gets one read. No authority
// action for the MCP actor; rollback (D3c) removes exactly the v13 delta.
const person = { issuer: 'host', subject: 'owner' };
const mcpRef = mcpPrincipalRef(person);
const owner = { id: 'owner', ...person, assurance: 'os-user' as const, scopeIds: ['installation', 'other'] };
const mcp = { ...owner, ...mcpRef, assurance: 'workload-verified' as const };
const colleague = { ...owner, id: 'colleague', subject: 'colleague' };
const names = { proposeMcpToolName: FIRST_RUN_TOOL_NAMES.proposeMcpToolName, mcpCallOperationId: FIRST_RUN_TOOL_NAMES.mcpCallOperationId,
  policyAdministerOperationId: FIRST_RUN_TOOL_NAMES.policyAdministerOperationId, executionEnvironmentIds: FIRST_RUN_TOOL_NAMES.executionEnvironmentIds };
const input = { scopeId: 'installation', principal: person, ...FIRST_RUN_TOOL_NAMES };
const built = firstRunPolicyTemplate(input);
const v13ids: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
const v12ids = [FIRST_RUN_UPGRADE_RULE_IDS.scopeInspect, FIRST_RUN_UPGRADE_RULE_IDS.serviceShutdown];
const v13 = built.policy.grants.filter(rule => v13ids.includes(rule.id));
const v12 = { ...built.policy, revision: 'first-run-template-v12', grants: built.policy.grants.filter(rule => !v13ids.includes(rule.id)) };
const v11 = { ...v12, revision: 'first-run-template-v11', grants: v12.grants.filter(rule => !v12ids.includes(rule.id)) };
const resolved = (policy: unknown) => resolvePolicyBindings(policy, built.bindings);
const allows = (policy: unknown, who: { readonly issuer: string; readonly subject: string }, scopeId: string, kind: string, action: string, id = 'x') =>
  evaluatePolicy(resolved(policy), { principal: { ...owner, ...who }, scopeId, action, resource: { kind, id } }).decision === 'allow';
/** The live and N1 policy shapes of 2026-10-19 (read-only copies of the alpha27 backups; host name and model hashes replaced). */
const shape = (name: 'live' | 'n1') => (JSON.parse(readFileSync(new URL(`../../fixtures/policy-shapes/${name}-2026-10-19.json`, import.meta.url), 'utf8')) as { policy: { grants: PolicyGrant[] } }).policy;
const shapePerson = { issuer: 'host', subject: '1000' };

it('v13 adds exactly seven rules: six naming the person alone, one read for the MCP actor; the ids are the rollback delta', () => {
  expect(built.version).toBe(13);
  expect(built.policy.revision).toBe('first-run-template-v13');
  expect(FIRST_RUN_EXECUTION_ENVIRONMENT_IDS).toEqual(['docker']);
  expect(v13).toEqual([
    { id: 'first-run-execution-environment-install', effect: 'allow', actions: ['install'], scopes: 'all', principals: [person], resource: { kind: 'execution-environment', ids: ['docker'] } },
    { id: 'first-run-installation-repair', effect: 'allow', actions: ['repair'], scopes: 'all', principals: [person], resource: { kind: 'installation', ids: 'all' } },
    { id: 'first-run-model-deactivation', effect: 'allow', actions: ['deactivate'], scopes: 'all', principals: [person], resource: { kind: 'model-activation', ids: 'all' } },
    { id: 'first-run-decision-inspect', effect: 'allow', actions: ['inspect'], scopes: ['installation'], principals: [person], resource: { kind: 'decision', ids: 'all' } },
    { id: 'first-run-monitor-scope-diagnostics', effect: 'allow', actions: ['inspect-scope-diagnostics'], scopes: 'all', principals: [person], resource: { kind: 'monitor', ids: 'all' } },
    { id: 'first-run-standing-grants-all', effect: 'allow', actions: ['inspect-standing-grants'], scopes: ['installation'], principals: [person], resource: { kind: 'policy', ids: 'all' } },
    { id: 'first-run-mcp-observe-pool', effect: 'allow', actions: ['inspect'], scopes: ['installation'], principals: [mcpRef], resource: { kind: 'pool', ids: 'all' } },
  ]);
  expect([...v13ids].sort()).toEqual(v13.map(rule => rule.id).sort());
  // v13 only adds: every v12 rule is still there, unchanged (C3 is its own rule beside the v7 activation rule, which keeps `activate`/`inspect`).
  expect(built.policy.grants.find(rule => rule.id === FIRST_RUN_UPGRADE_RULE_IDS.modelActivation)?.actions).toEqual(['activate', 'inspect']);
  // Every v13 rule names an action the published vocabulary has.
  const vocabulary = new Map(getPolicyVocabulary().resources.map(resource => [resource.kind as string, resource.actions as readonly string[]]));
  for (const rule of v13) for (const action of rule.actions === 'all' ? [] : rule.actions) expect(vocabulary.get(rule.resource.kind), `${rule.resource.kind}/${action}`).toContain(action);
});

it('the MCP actor never gets an authority action: a template built for it and every v13 person rule leave it denied; it only reads pools', () => {
  for (const rule of v13.filter(rule => rule.id !== FIRST_RUN_UPGRADE_RULE_IDS.observePool)) expect(rule.principals).toEqual([person]);
  const forMcp = firstRunPolicyTemplate({ ...input, principal: mcpRef }).policy.grants.filter(rule => v13ids.includes(rule.id));
  expect(forMcp.map(rule => rule.id)).toEqual([FIRST_RUN_UPGRADE_RULE_IDS.observePool]);
  const actions = [['execution-environment', 'install', 'docker'], ['installation', 'repair'], ['model-activation', 'deactivate'], ['decision', 'inspect'],
    ['monitor', 'inspect-scope-diagnostics'], ['policy', 'inspect-standing-grants']] as const;
  for (const [kind, action, id] of actions) {
    expect(allows(built.policy, person, 'installation', kind, action, id), `${kind}/${action}`).toBe(true);
    expect(allows(built.policy, mcpRef, 'installation', kind, action, id), `mcp ${kind}/${action}`).toBe(false);
    expect(allows(built.policy, colleague, 'installation', kind, action, id), `colleague ${kind}/${action}`).toBe(false);
    // v12 denied every one of them to the person (C3: its activation rule has no `deactivate`).
    expect(allows(v12, person, 'installation', kind, action, id), `v12 ${kind}/${action}`).toBe(false);
  }
  // Only the registered environment: another one is not covered by the install rule.
  expect(allows(built.policy, person, 'installation', 'execution-environment', 'install', 'podman')).toBe(false);
  // Installation-wide rules reach another scope; the scoped reads do not.
  expect(allows(built.policy, person, 'other', 'monitor', 'inspect-scope-diagnostics')).toBe(true);
  expect(allows(built.policy, person, 'other', 'decision', 'inspect')).toBe(false);
  expect(allows(built.policy, person, 'other', 'policy', 'inspect-standing-grants')).toBe(false);
  // The MCP pool read is inspect only, in the installed scope.
  expect(allows(built.policy, mcpRef, 'installation', 'pool', 'inspect')).toBe(true);
  for (const action of ['use', 'hold', 'resume', 'set-capacity', 'release-quota']) expect(allows(built.policy, mcpRef, 'installation', 'pool', action), action).toBe(false);
  expect(allows(built.policy, mcpRef, 'other', 'pool', 'inspect')).toBe(false);
});

it('the existing consumers decide the new reads: decide-list (`decision inspect`) for the person, MCP `pool inspect`; v12 denies both', async () => {
  const source = (policy: unknown) => ({ async load() { return resolved(policy); } });
  await expect(new DecisionPolicyAuthorization(source(v12)).authorize('inspect', 'installation', 'installation', owner)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(new DecisionPolicyAuthorization(source(built.policy)).authorize('inspect', 'installation', 'installation', owner))
    .resolves.toMatchObject({ ruleId: 'first-run-decision-inspect' });
  await expect(new DecisionPolicyAuthorization(source(built.policy)).authorize('inspect', 'installation', 'installation', mcp)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  // Other decision actions stay ungranted.
  await expect(new DecisionPolicyAuthorization(source(built.policy)).authorize('record', 'installation', 'installation', owner)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  const pool = (policy: unknown) => new PoolControlPolicyAuthorization(source(policy));
  expect(await pool(v12).decide('inspect', 'local', 'installation', mcp)).toMatchObject({ effect: 'deny' });
  expect(await pool(built.policy).decide('inspect', 'local', 'installation', mcp)).toMatchObject({ effect: 'allow', ruleId: 'first-run-mcp-observe-pool' });
  expect(await pool(built.policy).decide('hold', 'local', 'installation', mcp)).toMatchObject({ effect: 'deny' });
});

it('exact v12 and v11 templates become exactly v13; edited and hand-built policies get exactly the seven rules add-only; a second plan is current', () => {
  expect(upgradeFirstRunPolicy(v12, input)).toEqual({ status: 'upgrade', from: 12, policy: built.policy });
  expect(upgradeFirstRunPolicy(v11, input)).toEqual({ status: 'upgrade', from: 11, policy: built.policy });
  expect(upgradeFirstRunPolicy(built.policy, input)).toEqual({ status: 'current' });
  const edited = { ...v12, revision: 'a-edited', grants: [...v12.grants, { id: 'extra', effect: 'allow', actions: ['invoke'], scopes: ['installation'], principals: [person],
    resource: { kind: 'agent-tool', ids: ['fetch_url'] } }] };
  expect(upgradeFirstRunPolicy(edited, input)).toEqual({ status: 'unavailable', reason: 'not-v4-template' });
  const handBuilt = { ...edited, grants: edited.grants.map(rule => rule.id === 'first-run-read-tools' ? { ...rule, id: 'custom-read-tools' } : rule) };
  for (const [plan, current] of [[firstRunTemplateAdditions(edited, { ...names, person }), edited], [namedPersonPolicyAdditions(handBuilt, { ...names, person, scopeId: 'installation' }), handBuilt]] as const) {
    expect(plan.status).toBe('plan'); if (plan.status !== 'plan') throw new Error('missing v13 plan');
    expect(plan.rules).toEqual(v13); expect(plan.conflicts).toEqual([]);
    expect(plan.change.changes.every(change => change.kind === 'grant.add')).toBe(true);
    const applied = { ...current, grants: [...current.grants, ...plan.rules] };
    const again = current === edited ? firstRunTemplateAdditions(applied, { ...names, person }) : namedPersonPolicyAdditions(applied, { ...names, person, scopeId: 'installation' });
    expect(again.status).toBe('current');
  }
  // Never for the MCP actor or a person the policy does not name.
  expect(firstRunTemplateAdditions(edited, { ...names, person: mcpRef })).toEqual({ status: 'unavailable', reason: 'not-this-person' });
  expect(namedPersonPolicyAdditions(handBuilt, { ...names, person: mcpRef, scopeId: 'installation' })).toEqual({ status: 'unavailable', reason: 'person-not-named' });
});

it('C3: a person who already holds `model-activation deactivate` by hand (live/N1) gets no duplicate; the rest of the delta is still planned', () => {
  const edited = { ...v12, revision: 'a-edited', grants: [...v12.grants, { id: 'owner-model-catalog', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: 'all',
    principals: [person], resource: { kind: 'model-activation', ids: 'all' } }] };
  const plan = firstRunTemplateAdditions(edited, { ...names, person });
  expect(plan.status === 'plan' ? plan.rules.map(rule => rule.id) : []).toEqual(v13.map(rule => rule.id).filter(id => id !== FIRST_RUN_UPGRADE_RULE_IDS.modelDeactivation));
});

it('live and N1 shapes (2026-10-19, hand-built): the named person gets only v13 rules, the hand-held deactivate is not duplicated, nothing conflicts', () => {
  for (const name of ['live', 'n1'] as const) {
    const policy = shape(name);
    // Their configured runtime service id is `local` (live-service-shutdown), so the v12 stop rule is already covered.
    const plan = namedPersonPolicyAdditions(policy, { ...names, person: shapePerson, scopeId: 'live', serviceId: 'local' });
    expect(plan.status, name).toBe('plan'); if (plan.status !== 'plan') throw new Error(name);
    expect(plan.conflicts, name).toEqual([]);
    expect(plan.rules.map(rule => rule.id), name).toEqual(['first-run-execution-environment-install', 'first-run-installation-repair', 'first-run-decision-inspect',
      'first-run-monitor-scope-diagnostics', 'first-run-standing-grants-all', 'first-run-mcp-observe-pool']);
    for (const rule of plan.rules) expect(rule.principals, rule.id).toEqual([rule.id === 'first-run-mcp-observe-pool' ? mcpPrincipalRef(shapePerson) : shapePerson]);
    expect(plan.rules.filter(rule => rule.scopes !== 'all').every(rule => rule.scopes !== 'all' && rule.scopes.length === 1 && rule.scopes[0] === 'live')).toBe(true);
    // Applied, a second plan is current: no repeated additions.
    expect(namedPersonPolicyAdditions({ ...policy, grants: [...policy.grants, ...plan.rules] }, { ...names, person: shapePerson, scopeId: 'live', serviceId: 'local' }).status).toBe('current');
  }
});

it('rollback (D3c) removes exactly the held v13 delta; v11 delivery and v12 owner rules stay; doctor recognises v13 and no later version', () => {
  const delta = firstRunTemplateRollback(built.policy, person, 'installation', names);
  expect(delta.rules.map(rule => rule.id)).toEqual(v13.map(rule => rule.id)); expect(delta.conflicts).toEqual([]);
  for (const id of [FIRST_RUN_UPGRADE_RULE_IDS.quotaRelease, FIRST_RUN_UPGRADE_RULE_IDS.integration, FIRST_RUN_UPGRADE_RULE_IDS.workTargetAdopt, ...v12ids]) {
    expect(v13ids.includes(id), id).toBe(false);
  }
  // A same-id rule with other content is a named conflict, never removed.
  const customized = { ...built.policy, grants: built.policy.grants.map(rule => rule.id === FIRST_RUN_UPGRADE_RULE_IDS.installationRepair ? { ...rule, scopes: ['installation'] } : rule) };
  const kept = firstRunTemplateRollback(customized, person, 'installation', names);
  expect(kept.conflicts).toEqual([FIRST_RUN_UPGRADE_RULE_IDS.installationRepair]);
  expect(kept.rules.map(rule => rule.id)).not.toContain(FIRST_RUN_UPGRADE_RULE_IDS.installationRepair);
  expect(firstRunTemplateRollback(built.policy, mcpRef, 'installation', names)).toEqual({ rules: [], conflicts: [] });
  expect(matchFirstRunPolicyTemplate('first-run-template-v13')).toEqual({ id: 'first-run-template', version: 13 });
  expect(matchFirstRunPolicyTemplate('first-run-template-v14')).toBeNull();
});
