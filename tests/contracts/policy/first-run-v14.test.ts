import { FIRST_RUN_V16_RULE_IDS } from '../support/first-run-v16.js';
import { expect, it } from 'vitest';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS as FIRST_RUN_V17_RULE_IDS, FIRST_RUN_UPGRADE_RULE_IDS, evaluatePolicy, firstRunPolicyTemplate, firstRunTemplateAdditions, firstRunTemplateRollback,
  matchFirstRunPolicyTemplate, mcpPrincipalRef, namedPersonPolicyAdditions, resolvePolicyBindings, upgradeFirstRunPolicy } from '#domain/index.js';
import { FIRST_RUN_TOOL_NAMES, MemoryPolicyAuthorization } from '#engine/index.js';
import { FIRST_RUN_V15_RULE_IDS } from '../support/first-run-v15.js';

// Historical fixtures before v16 exclude both later additive deltas.
const POST_V15_RULE_IDS: readonly string[] = [...FIRST_RUN_V16_RULE_IDS, ...FIRST_RUN_V17_RULE_IDS];

// S4 (lead 2026-10-23): one bump v13 → v14 with two add-only rules — the named person reads the installed scope's memory journal, the MCP actor
// gets the same read (observation). No memory change for the person or the MCP actor (propose/verify/retire stay ungranted). S4B-1's v15 delta
// (first-run-v15.test.ts) is removed here to derive v14; rollback now removes the v15 delta.
const person = { issuer: 'host', subject: 'owner' };
const mcpRef = mcpPrincipalRef(person);
const owner = { id: 'owner', ...person, assurance: 'os-user' as const, scopeIds: ['installation', 'other'] };
const mcp = { ...owner, ...mcpRef, assurance: 'workload-verified' as const };
const names = { proposeMcpToolName: FIRST_RUN_TOOL_NAMES.proposeMcpToolName, mcpCallOperationId: FIRST_RUN_TOOL_NAMES.mcpCallOperationId,
  policyAdministerOperationId: FIRST_RUN_TOOL_NAMES.policyAdministerOperationId, firstCommitOperationId: 'coding.first-commit', executionEnvironmentIds: FIRST_RUN_TOOL_NAMES.executionEnvironmentIds };
const input = { scopeId: 'installation', principal: person, ...FIRST_RUN_TOOL_NAMES };
const current = firstRunPolicyTemplate(input), v15ids: readonly string[] = [...FIRST_RUN_V15_RULE_IDS, ...POST_V15_RULE_IDS];
const built = { ...current, version: 14, policy: { ...current.policy, revision: 'first-run-template-v14', grants: current.policy.grants.filter(rule => !v15ids.includes(rule.id)) },
  bindings: { ...current.bindings as object, revision: 'first-run-template-v14-bindings' } };
const v14ids: readonly string[] = [FIRST_RUN_UPGRADE_RULE_IDS.memoryInspect, FIRST_RUN_UPGRADE_RULE_IDS.observeMemory];
const v14 = built.policy.grants.filter(rule => v14ids.includes(rule.id));
const v13 = { ...built.policy, revision: 'first-run-template-v13', grants: built.policy.grants.filter(rule => !v14ids.includes(rule.id)) };
const source = (policy: unknown) => ({ async load() { return resolvePolicyBindings(policy, built.bindings); } });

it('v14 adds exactly two rules: memory inspect for the named person and for the MCP actor; the ids are the rollback delta', () => {
  expect(built.version).toBe(14); expect(built.policy.revision).toBe('first-run-template-v14');
  expect(v14).toEqual([
    { id: 'first-run-memory-inspect', effect: 'allow', actions: ['inspect'], scopes: ['installation'], principals: [person], resource: { kind: 'memory', ids: 'all' } },
    { id: 'first-run-mcp-observe-memory', effect: 'allow', actions: ['inspect'], scopes: ['installation'], principals: [mcpRef], resource: { kind: 'memory', ids: 'all' } },
  ]);
  expect(firstRunPolicyTemplate({ ...input, principal: mcpRef }).policy.grants.filter(rule => v14ids.includes(rule.id)).map(rule => rule.id)).toEqual([FIRST_RUN_UPGRADE_RULE_IDS.observeMemory]);
});

it('the memory application decides the new read: the person and the MCP actor may inspect, nobody may propose, verify or retire; v13 denies the read', async () => {
  const auth = (policy: unknown) => new MemoryPolicyAuthorization(source(policy));
  await expect(auth(v13).authorize('inspect', 'installation', owner)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(auth(built.policy).authorize('inspect', 'installation', owner)).resolves.toMatchObject({ ruleId: 'first-run-memory-inspect' });
  await expect(auth(built.policy).authorize('inspect', 'installation', mcp)).resolves.toMatchObject({ ruleId: 'first-run-mcp-observe-memory' });
  await expect(auth(built.policy).authorize('inspect', 'other', owner)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  for (const action of ['propose', 'verify', 'retire'] as const) for (const who of [owner, mcp])
    await expect(auth(built.policy).authorize(action, 'installation', who), `${who.id} ${action}`).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(evaluatePolicy(resolvePolicyBindings(built.policy, built.bindings), { principal: mcp, scopeId: 'installation', action: 'inspect', resource: { kind: 'memory', id: 'installation' } }).decision).toBe('allow');
});

it('exact v13 becomes exactly the current template; edited and hand-built policies get the v14 rules add-only (before v15\'s); doctor knows v14', () => {
  expect(upgradeFirstRunPolicy(v13, input)).toEqual({ status: 'upgrade', from: 13, policy: current.policy });
  expect(upgradeFirstRunPolicy(built.policy, input)).toEqual({ status: 'upgrade', from: 14, policy: current.policy });
  const edited = { ...v13, revision: 'a-edited', grants: [...v13.grants, { id: 'extra', effect: 'allow', actions: ['invoke'], scopes: ['installation'], principals: [person],
    resource: { kind: 'agent-tool', ids: ['fetch_url'] } }] };
  const handBuilt = { ...edited, grants: edited.grants.map(rule => rule.id === 'first-run-read-tools' ? { ...rule, id: 'custom-read-tools' } : rule) };
  for (const plan of [firstRunTemplateAdditions(edited, { ...names, person }), namedPersonPolicyAdditions(handBuilt, { ...names, person, scopeId: 'installation' })]) {
    expect(plan.status === 'plan' ? plan.rules.slice(0, 2) : null).toEqual(v14);
  }
  // The rollback delta is v15's now: a v14 policy holds none of it, and keeps its v14 reads.
  expect(firstRunTemplateRollback(built.policy, person, 'installation').rules).toEqual([]);
  expect(matchFirstRunPolicyTemplate('first-run-template-v14')).toEqual({ id: 'first-run-template', version: 14 });
});

it('law-audit fold 6: memory verify and retire are on the AI hard floor — a rule naming the AI or the MCP actor is refused, the person keeps them', async () => {
  const workload = { ...owner, id: 'worker', issuer: 'deckent-worker', subject: 'attempt', assurance: 'workload-verified' as const };
  const granted = { ...built.policy, revision: 'a-granted', grants: [...built.policy.grants, ...[mcpRef, person, { issuer: workload.issuer, subject: workload.subject }].map((who, index) => ({
    id: `memory-write-${index}`, effect: 'allow', actions: ['propose', 'verify', 'retire'], scopes: ['installation'], principals: [who], resource: { kind: 'memory', ids: 'all' } }))] };
  const decide = (who: typeof owner, action: string) => evaluatePolicy(resolvePolicyBindings(granted, built.bindings), { principal: who, scopeId: 'installation', action, resource: { kind: 'memory', id: 'installation' } });
  for (const who of [mcp, workload]) for (const action of ['verify', 'retire']) expect(decide(who, action), `${who.id} ${action}`).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  // The floor covers only the knowledge-changing actions: an AI candidate (propose) and every read stay policy decisions.
  expect(decide(mcp, 'propose').decision).toBe('allow'); expect(decide(mcp, 'inspect').decision).toBe('allow');
  for (const action of ['verify', 'retire']) expect(decide(owner, action).decision, `person ${action}`).toBe('allow');
  await expect(new MemoryPolicyAuthorization(source(granted)).authorize('verify', 'installation', mcp)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});
