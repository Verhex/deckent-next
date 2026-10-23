import { expect, it } from 'vitest';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, FIRST_RUN_UPGRADE_RULE_IDS, evaluatePolicy, firstRunPolicyTemplate, firstRunTemplateAdditions, firstRunTemplateRollback,
  matchFirstRunPolicyTemplate, mcpPrincipalRef, memoryDistillerPrincipal, memoryDistillerPrincipalRef, memoryEvaluatorPrincipal, memoryEvaluatorPrincipalRef, namedPersonPolicyAdditions, recoveryPrincipalRef, resolvePolicyBindings,
  upgradeFirstRunPolicy } from '#domain/index.js';
import { FIRST_RUN_TOOL_NAMES, MemoryPolicyAuthorization } from '#engine/index.js';

// S4B-1 + S7 (owner S-M1/S-M2 2026-10-23, S4B-DESIGN §5 A2/A2b; lead: v15 carries s7's agent-catalog grants): one add-only bump v14 → v15. The memory
// distiller workload gets D1+D2 (memory inspect, propose), D4 (run inspect) and, as its own rule, D3 (attempt read-output); the named person may
// propose memory (the delegation bound needs it to grant D2) and inspects and defines in the agent/skill catalog, the MCP actor inspects it.
// S4B-3 (owner S-M3/S-M5, §5 A6/A7): the person may verify and contest (the delegation bound needs both to grant V2/V3); the memory evaluator workload gets V1–V3 (memory inspect, verify, contest), V4 (run inspect) and, as its own
// rule, V5 (model-invocation invoke). Rollback removes exactly this delta.
const person = { issuer: 'host', subject: 'owner' };
const mcpRef = mcpPrincipalRef(person), distillerRef = memoryDistillerPrincipalRef(person), evaluatorRef = memoryEvaluatorPrincipalRef(person);
const owner = { id: 'owner', ...person, assurance: 'os-user' as const, scopeIds: ['installation', 'other'] };
const distiller = memoryDistillerPrincipal(person, ['installation', 'other']), evaluator = memoryEvaluatorPrincipal(person, ['installation', 'other']);
const names = { proposeMcpToolName: FIRST_RUN_TOOL_NAMES.proposeMcpToolName, mcpCallOperationId: FIRST_RUN_TOOL_NAMES.mcpCallOperationId,
  policyAdministerOperationId: FIRST_RUN_TOOL_NAMES.policyAdministerOperationId, executionEnvironmentIds: FIRST_RUN_TOOL_NAMES.executionEnvironmentIds };
const input = { scopeId: 'installation', principal: person, ...FIRST_RUN_TOOL_NAMES };
const built = firstRunPolicyTemplate(input), ids: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
const v15 = built.policy.grants.filter(rule => ids.includes(rule.id));
const v14 = { ...built.policy, revision: 'first-run-template-v14', grants: built.policy.grants.filter(rule => !ids.includes(rule.id)) };
const scoped = (id: string, principal: object, kind: string, actions: string[]) => ({ id, effect: 'allow', actions, scopes: ['installation'], principals: [principal], resource: { kind, ids: 'all' } });
const decide = (policy: unknown, principal: typeof owner, kind: string, action: string, scopeId = 'installation') =>
  evaluatePolicy(resolvePolicyBindings(policy, built.bindings), { principal, scopeId, action, resource: { kind, id: kind === 'memory' || kind === 'agent-catalog' ? scopeId : 'x' } });

it('v15 adds exactly the person\'s memory propose, the distiller D1+D2, D4 and D3 (own rule) and the agent catalog rules; the ids are the rollback delta', () => {
  expect(built.version).toBe(15); expect(built.policy.revision).toBe('first-run-template-v15');
  expect(v15).toEqual([scoped('first-run-memory-propose', person, 'memory', ['propose']), scoped('first-run-memory-distiller', distillerRef, 'memory', ['inspect', 'propose']), scoped('first-run-memory-distiller-runs', distillerRef, 'run', ['inspect']),
    scoped('first-run-memory-distiller-output', distillerRef, 'attempt', ['read-output']), scoped('first-run-agent-catalog', person, 'agent-catalog', ['inspect', 'define']),
    scoped('first-run-mcp-observe-agent-catalog', mcpRef, 'agent-catalog', ['inspect']), scoped('first-run-memory-review', person, 'memory', ['verify', 'contest']),
    scoped('first-run-memory-evaluator', evaluatorRef, 'memory', ['inspect', 'verify', 'contest']),
    scoped('first-run-memory-evaluator-runs', evaluatorRef, 'run', ['inspect']), scoped('first-run-memory-evaluator-model', evaluatorRef, 'model-invocation', ['invoke']),
    // S4B-4 (owner S-M12, A11): the named person retires and purges memory (the purge card); no model-invocation grant (lead review 2026-10-23).
    scoped('first-run-memory-purge', person, 'memory', ['retire', 'purge']),
    // S6R-5: the recovery principal invokes its recovery-decision role model (its floor refuses every other pair).
    scoped('first-run-recovery-model', recoveryPrincipalRef(person), 'model-invocation', ['invoke'])]);
  expect(firstRunPolicyTemplate({ ...input, principal: mcpRef }).policy.grants.filter(rule => ids.includes(rule.id)).map(rule => rule.id)).toEqual([FIRST_RUN_UPGRADE_RULE_IDS.observeAgentCatalog]);
});

it('the grants decide only inside the floor: the distiller proposes and reads, never verifies, retires, purges or imports; nothing outside the installed scope', async () => {
  for (const [kind, action] of [['memory', 'inspect'], ['memory', 'propose'], ['run', 'inspect'], ['attempt', 'read-output']]) expect(decide(built.policy, distiller, kind!, action!).decision).toBe('allow');
  for (const [kind, action] of [['memory', 'propose'], ['run', 'inspect']]) expect(decide(v14, distiller, kind!, action!).decision).toBe('deny');
  for (const [kind, action] of [['memory', 'verify'], ['memory', 'retire'], ['memory', 'purge'], ['agent-catalog', 'inspect'], ['attempt', 'execute']])
    expect(decide(built.policy, distiller, kind!, action!).decision, `${kind}/${action}`).toBe('deny');
  expect(decide(built.policy, distiller, 'memory', 'propose', 'other').decision).toBe('deny');
  await expect(new MemoryPolicyAuthorization({ async load() { return resolvePolicyBindings(built.policy, built.bindings); } }).authorize('propose', 'installation', distiller))
    .resolves.toMatchObject({ ruleId: 'first-run-memory-distiller' });
  // S4B-3: the evaluator verifies, contests, reads Runs and invokes its model; it never proposes, retires, purges or reads raw worker output.
  for (const [kind, action] of [['memory', 'inspect'], ['memory', 'verify'], ['memory', 'contest'], ['run', 'inspect'], ['model-invocation', 'invoke']])
    expect(decide(built.policy, evaluator, kind!, action!).decision, `${kind}/${action}`).toBe('allow');
  for (const [kind, action] of [['memory', 'propose'], ['memory', 'retire'], ['memory', 'purge'], ['attempt', 'read-output'], ['model-invocation', 'inspect-content']])
    expect(decide(built.policy, evaluator, kind!, action!).decision, `${kind}/${action}`).toBe('deny');
  expect(decide(built.policy, evaluator, 'memory', 'verify', 'other').decision).toBe('deny');
  expect(decide(built.policy, distiller, 'memory', 'verify').decision).toBe('deny');
  for (const action of ['inspect', 'define']) expect(decide(built.policy, owner, 'agent-catalog', action).decision).toBe('allow');
  expect(decide(built.policy, owner, 'agent-catalog', 'import').decision).toBe('deny');
  // The person may propose (their own card; it lets them delegate D2) and, S4B-3, verify and contest (it lets them delegate V2/V3; a person's verify is a
  // human review at the terminal); S4B-4: retire and purge (the person's review and purge cards).
  for (const action of ['propose', 'verify', 'contest', 'retire', 'purge']) expect(decide(built.policy, owner, 'memory', action).decision, action).toBe('allow');
  for (const action of ['retire', 'purge']) expect(decide(v14, owner, 'memory', action).decision, action).toBe('deny');
  // Lead review 2026-10-23: the purge reaches only its entry's evaluator calls under the memory/purge decision; the template grants no purge-content.
  expect(decide(built.policy, owner, 'model-invocation', 'purge-content').decision).toBe('deny');
  // A11: no AI purges — the MCP actor holds no such rule, and the floor refuses the evaluator and distiller whatever a rule says.
  const mcpActor = { ...owner, id: 'mcp', issuer: mcpRef.issuer };
  for (const principal of [mcpActor, evaluator, distiller]) for (const action of ['purge', 'retire']) expect(decide(built.policy, principal, 'memory', action).decision, `${principal.issuer}/${action}`).toBe('deny');
  const widened = { ...built.policy, grants: [...built.policy.grants, { ...scoped('wide', mcpRef, 'memory', ['retire', 'purge']) }, { ...scoped('wide-e', evaluatorRef, 'memory', ['retire', 'purge']) }] };
  for (const principal of [mcpActor, evaluator]) expect(decide(widened, principal, 'memory', 'purge').decision, principal.issuer).toBe('deny');
});

it('exact v14 becomes exactly v15; edited and hand-built policies get the delta add-only; a person\'s broader rule never stands in for the distiller\'s; rollback removes exactly v15', () => {
  expect(upgradeFirstRunPolicy(v14, input)).toEqual({ status: 'upgrade', from: 14, policy: built.policy });
  expect(upgradeFirstRunPolicy(built.policy, input)).toEqual({ status: 'current' });
  const extra = { id: 'extra', effect: 'allow', actions: ['inspect', 'propose'], scopes: ['installation'], principals: [person], resource: { kind: 'memory', ids: 'all' } };
  const edited = { ...v14, revision: 'a-edited', grants: [...v14.grants, extra] };
  const handBuilt = { ...edited, grants: edited.grants.map(rule => rule.id === 'first-run-read-tools' ? { ...rule, id: 'custom-read-tools' } : rule) };
  for (const plan of [firstRunTemplateAdditions(edited, { ...names, person }), namedPersonPolicyAdditions(handBuilt, { ...names, person, scopeId: 'installation' })]) {
    // The person's own `extra` rule covers their propose cell, never the distiller's: only the distiller and catalog rules are added.
    expect(plan.status === 'plan' ? plan.rules : null).toEqual(v15.filter(rule => rule.id !== FIRST_RUN_UPGRADE_RULE_IDS.memoryPropose));
  }
  expect(firstRunTemplateRollback(built.policy, person, 'installation').rules.map(rule => rule.id)).toEqual(v15.map(rule => rule.id));
  expect(matchFirstRunPolicyTemplate('first-run-template-v15')).toEqual({ id: 'first-run-template', version: 15 });
});
