import { expect, it } from 'vitest';
import { renderRunCreateApprovalSummary, type BoundRunAdmission, type RunCreate } from '#engine/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';
import { proposalFixture } from '../support/run-proposal.js';
import { fixtureExecution } from '../support/execution-registry.js';
const proposal = proposalFixture();
const command: BoundRunAdmission = { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'run-business', graph: proposal.graph,
  proposal: { schemaVersion: 1, proposalId: 'p', digest: 'a'.repeat(64), budgetCeiling: proposal.budgetCeiling,
    requiredPermissions: [{ kind: 'task', action: 'execute', resourceId: 'purchase' }], admission: null } };
const create: RunCreate = { commandId: command.commandId, actor: proposal.proposer, graph: command.graph,
  identity: { scopeId: 's', runId: command.runId, layoutRevision: 'layout' }, now: 1, execution: fixtureExecution(command.graph),
  policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['task'] } };
const verdict = { decision: 'require-approval', revision: 'p1', ruleId: 'owner-purchase', reason: 'APPROVAL_REQUIRED' } as const;
for (const locale of ['en', 'tr'] as const) it(`${locale}: durable summary uses titles/classes, permissions, ceiling and the exact asking rule`, () => {
  const text = renderRunCreateApprovalSummary(command, create, verdict, locale);
  expect(text).toContain(locale === 'tr' ? 'Plan · görevler: 1' : 'Plan · tasks: 1');
  expect(text).toContain('task'); expect(text).toContain('purchase'); expect(text).toContain('small');
  expect(text).toContain('task / execute / purchase'); expect(text).toContain('200 USD'); expect(text).toContain('owner-purchase');
  expect(text).toContain(locale === 'tr' ? 'yalnız kabul anında' : 'only at admission');
  expect(text).toContain('APPROVAL_REQUIRED'); expect(text).toContain('run-business');
});
it('raw create reports undeclared permissions/ceiling/class; a registry gate is distinct from a policy rule', () => {
  const raw = { schemaVersion: command.schemaVersion, commandId: command.commandId, scopeId: command.scopeId, runId: command.runId, graph: command.graph };
  const graph = { ...raw.graph, tasks: raw.graph.tasks.map(task => ({ id: task.id, kind: task.kind, dependencies: task.dependencies, acceptanceCriteria: task.acceptanceCriteria })) };
  const noRule = { decision: verdict.decision, revision: verdict.revision, reason: verdict.reason };
  const text = renderRunCreateApprovalSummary({ ...raw, graph }, { ...create, graph }, noRule);
  expect(text).toContain('work class: not declared'); expect(text).toContain('Declared permissions: not declared');
  expect(text).toContain('Declared budget ceiling (minor units): not declared'); expect(text).toContain('work-class registry');
});
it('redacts complete fields before cutting and again after ANSI/control reconstruction, including known secrets', () => {
  const task = command.graph.tasks[0]!;
  const known = snapshotKnownSecrets([{ value: 'private-fixture-value', name: 'FIXTURE' }]);
  const id = 'x'.repeat(70) + 'sk-approval-fixture-token' + '\u001b[31m private-fixture-value\u001b[0m';
  const graph = { ...command.graph, tasks: [{ ...task, id }] };
  const text = renderRunCreateApprovalSummary({ ...command, graph }, { ...create, graph }, verdict, 'en', known);
  expect(text).not.toContain('sk-approval'); expect(text).not.toContain('private-fixture-value'); expect(text).not.toContain('\u001b');
  const reconstructed = { ...graph, tasks: [{ ...task, id: 'token=sk-\u001b[31mfixture-secret' }] };
  expect(renderRunCreateApprovalSummary({ ...command, graph: reconstructed }, { ...create, graph: reconstructed }, verdict)).toContain('[REDACTED]');
  expect(renderRunCreateApprovalSummary({ ...command, graph: reconstructed }, { ...create, graph: reconstructed }, verdict)).not.toContain('fixture-secret');
});
it('prefers the declared title over the instruction, masks its secrets, and preserves the input unchanged', () => {
  const graph = { ...command.graph, tasks: [{ ...command.graph.tasks[0]!, workInput: { schemaVersion: 1 as const,
    title: 'Approve purchase api_key=sk-title-fixture', task: 'Instruction that should not replace the title', scope: { paths: ['purchase'] },
    acceptance: 'Durable purchase evidence', model: { channelId: 'fixture', modelId: 'fixture-model' } } }] };
  const before = JSON.stringify(graph);
  const text = renderRunCreateApprovalSummary({ ...command, graph }, { ...create, graph }, verdict);
  expect(text).toContain('Approve purchase api_key=[REDACTED]'); expect(text).not.toContain('sk-title-fixture');
  expect(text).not.toContain('Instruction that'); expect(JSON.stringify(graph)).toBe(before);
});
it('bounds many long tasks and permissions while preserving totals, omissions, budget and decision', () => {
  const graph = { ...command.graph, tasks: Array.from({ length: 60 }, (_, i) => ({ ...command.graph.tasks[0]!, id: `task-${i}-` + 'long'.repeat(1000) })) };
  const permissions = Array.from({ length: 60 }, (_, i) => ({ kind: 'kind'.repeat(32), action: 'action'.repeat(32), resourceId: `resource-${i}-` + 'long'.repeat(1000) }));
  for (const locale of ['tr', 'en'] as const) {
    const text = renderRunCreateApprovalSummary({ ...command, graph, proposal: { ...command.proposal!, requiredPermissions: permissions } }, { ...create, graph }, verdict, locale);
    expect(text.length).toBeLessThanOrEqual(2048); expect(text).toContain('60'); expect(text).not.toContain('task-5-');
    expect(text).not.toContain('resource-3-'); expect(text).toContain('55'); expect(text).toContain('57'); expect(text).toContain('200 USD');
    expect(text).toContain('owner-purchase'); expect(text).toContain('…');
  }
});

it.each(['en', 'tr'] as const)('subscription approval summary declares budget exemption without replacing approval (%s)', locale => {
  const value = { ...command, proposal: { ...command.proposal!, admission: { registryRevision: 'r', registryDigest: 'b'.repeat(64),
    standingAdmission: false, budgetSemantics: 'not-metered' as const, budget: null } } };
  const text = renderRunCreateApprovalSummary(value, create, verdict, locale);
  expect(text).toContain(locale === 'tr' ? 'Abonelik/ücretsiz model — bütçe kontrolü uygulanmaz' : 'Subscription/free model — budget check does not apply');
  expect(text).toContain('owner-purchase'); expect(text).toContain('run-business');
  expect(text).not.toContain(locale === 'tr' ? 'yalnız kabul anında' : 'only at admission');
});
