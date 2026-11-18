import { expect, it } from 'vitest';
import { renderRunCreateApprovalSummary, type BoundRunAdmission, type RunCreate } from '#engine/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';
import { mcpPrincipalRef, NATIVE_CLI_WORKER_ADAPTER_ID } from '#domain/index.js';
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
it('119-rev F1: Docker and mixed cards attribute tool protection only to the native worker (EN/TR)', () => {
  const task = command.graph.tasks[0]!, row = create.execution.tasks[0]!;
  const docker = { ...row, profile: { ...row.profile, id: 'docker-profile', adapter: { id: 'docker', version: 2 } } };
  const native = { ...row, taskId: 'native-task', profile: { ...row.profile, id: 'native-profile', adapter: { id: NATIVE_CLI_WORKER_ADAPTER_ID, version: 1 } } };
  for (const locale of ['en', 'tr'] as const) {
    const only = renderRunCreateApprovalSummary(command, { ...create, execution: { ...create.execution, tasks: [docker], workerMode: { mode: 'standart', askEdits: false } } }, verdict, locale);
    expect(only).toContain(locale === 'en' ? 'Recorded worker ceiling: standard' : 'Kayıtlı işçi tavanı: standart');
    expect(only).toContain(locale === 'en' ? 'docker-profile: its own sandbox/profile limits apply; no per-tool mode check.' : 'docker-profile: kendi sandbox/profil sınırları geçerlidir; araç başına mod denetimi yoktur.');
    expect(only).not.toContain(locale === 'en' ? 'destructive commands always ask' : 'yıkıcı komutlar her zaman sorulur');
    const graph = { ...command.graph, tasks: [task, { ...task, id: 'native-task' }] };
    const mixed = renderRunCreateApprovalSummary({ ...command, graph }, { ...create, graph, execution: { ...create.execution, tasks: [docker, native], workerMode: { mode: 'standart', askEdits: false } } }, verdict, locale);
    expect(mixed).toContain(locale === 'en' ? 'native-profile: per-tool mode check; lowering your mode applies; full access never passes; destructive commands always ask.' : 'native-profile: araç başına mod denetimi; modunuzu düşürmeniz uygulanır; tam erişim aktarılmaz; yıkıcı komutlar her zaman sorulur.');
    expect(mixed).toContain('docker-profile');
  }
});
for (const locale of ['en', 'tr'] as const) it(`${locale}: durable summary uses titles/classes, permissions, ceiling and the exact asking rule`, () => {
  const text = renderRunCreateApprovalSummary(command, create, verdict, locale);
  expect(text).toContain(locale === 'tr' ? 'Plan · görevler: 1' : 'Plan · tasks: 1');
  expect(text).toContain('task'); expect(text).toContain('purchase'); expect(text).toContain('small');
  expect(text).toContain('task / execute / purchase'); expect(text).toContain(locale === 'tr' ? '2,00 $' : '$2.00'); expect(text).toContain('owner-purchase');
  expect(text).toContain(locale === 'tr' ? 'yalnız kabul anında' : 'only at admission');
  // F2-12: the plain approval requirement is said in words (no raw code); the head (title) comes before the details (rule, permissions, Run id).
  expect(text).not.toContain('APPROVAL_REQUIRED'); expect(text).toContain('run-business');
  expect(text.indexOf(locale === 'tr' ? 'Ayrıntılar:' : 'Details:')).toBeGreaterThan(text.indexOf('• task'));
  expect(text.indexOf(locale === 'tr' ? 'Ayrıntılar:' : 'Details:')).toBeLessThan(text.indexOf('owner-purchase'));
  // R9: a Run with a worker shows the recorded worker ceiling; without one the card has no such line.
  const line = locale === 'tr' ? 'Kayıtlı işçi tavanı: ' : 'Recorded worker ceiling: ';
  expect(text).not.toContain(line);
  const ai = renderRunCreateApprovalSummary(command, { ...create, actor: { ...create.actor, ...mcpPrincipalRef(create.actor) } }, verdict, locale);
  expect(ai).toContain(locale === 'tr' ? "İş AI'ın kendi yürütme izinleriyle başlar; bu kart eksik politika izni vermez."
    : "Work starts under the AI's own execution permissions; this card grants no missing policy permission.");
  expect(text).not.toContain(locale === 'tr' ? 'AI\'ın kendi yürütme' : "AI's own execution");
  expect(renderRunCreateApprovalSummary(command, { ...create, actor: { ...create.actor, ...mcpPrincipalRef(create.actor) },
    execution: { ...create.execution, workerMode: { mode: 'full-auto', askEdits: true } } }, verdict, locale))
    .toContain(locale === 'tr' ? 'tam otomatik, düzenlemeler için onayla' : 'full auto, with approval for edits');
  for (const [workerMode, word] of [[{ mode: 'full-auto', askEdits: false }, locale === 'tr' ? 'tam otomatik' : 'full auto'], [{ mode: 'standart', askEdits: true }, locale === 'tr' ? 'dikkatli' : 'careful']] as const)
    expect(renderRunCreateApprovalSummary(command, { ...create, execution: { ...create.execution, workerMode } }, verdict, locale)).toContain(line + word);
});
it('raw create reports undeclared permissions/ceiling/class; a registry gate is distinct from a policy rule', () => {
  const raw = { schemaVersion: command.schemaVersion, commandId: command.commandId, scopeId: command.scopeId, runId: command.runId, graph: command.graph };
  const graph = { ...raw.graph, tasks: raw.graph.tasks.map(task => ({ id: task.id, kind: task.kind, dependencies: task.dependencies, acceptanceCriteria: task.acceptanceCriteria })) };
  const noRule = { decision: verdict.decision, revision: verdict.revision, reason: verdict.reason };
  // The raw create's execution is resolved from its own graph (as admission does): since the ATAMA-0 seed every Core class freezes an
  // acceptance profile, reusing the proposal graph's execution would seal that graph's class and the card would rightly name it.
  const text = renderRunCreateApprovalSummary({ ...raw, graph }, { ...create, graph, execution: fixtureExecution(graph) }, noRule);
  expect(text).toContain('work class: not declared'); expect(text).toContain('Also mentioned by the proposal (advisory, not evaluated, grants nothing): not declared');
  expect(text).not.toContain('Checked by policy at the start');
  expect(text).toContain('Declared budget ceiling: not declared'); expect(text).toContain('work-class registry');
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
    expect(text).not.toContain('resource-3-'); expect(text).toContain('55'); expect(text).toContain('57'); expect(text).toContain(locale === 'tr' ? '2,00 $' : '$2.00');
    expect(text).toContain('owner-purchase'); expect(text).toContain('…');
  }
});

it.each(['en', 'tr'] as const)('subscription approval summary declares budget exemption without replacing approval (%s)', locale => {
  const value = { ...command, proposal: { ...command.proposal!, admission: { registryRevision: 'r', registryDigest: 'b'.repeat(64),
    standingAdmission: false, budgetSemantics: 'not-metered' as const, budget: null } } };
  const text = renderRunCreateApprovalSummary(value, create, verdict, locale);
  expect(text).toContain(locale === 'tr' ? 'İşçiler: abonelik veya ek ücret gerektirmeyen model — API bütçesi uygulanmaz' : 'Workers: subscription or local model — no extra cost; budget check does not apply');
  expect(text).toContain('owner-purchase'); expect(text).toContain('run-business');
  expect(text).not.toContain(locale === 'tr' ? 'yalnız kabul anında' : 'only at admission');
  expect(text).not.toContain(locale === 'tr' ? 'bütçe tavanı' : 'budget ceiling'); // R9d: no API ceiling row for not-metered workers
});
it('proposer-authored long titles cannot push declared permissions off the card; the authority notice stays', () => {
  const graph = { ...command.graph, tasks: Array.from({ length: 40 }, (_, i) => ({ ...command.graph.tasks[0]!, id: `harmless-read-only-check-${i}-` + 'x'.repeat(400) })) };
  const permissions = [{ kind: 'operation', action: 'execute', resourceId: 'erp-write-invoice' }, { kind: 'secret', action: 'switch', resourceId: 'live-key' },
    { kind: 'config', action: 'write', resourceId: 'policy' }];
  for (const locale of ['tr', 'en'] as const) {
    const text = renderRunCreateApprovalSummary({ ...command, graph, proposal: { ...command.proposal!, requiredPermissions: permissions } }, { ...create, graph }, verdict, locale);
    expect(text.length).toBeLessThanOrEqual(2048);
    for (const row of ['operation / execute / erp-write-invoice', 'secret / switch / live-key', 'config / write / policy']) expect(text).toContain(row);
    expect(text).toContain(locale === 'tr' ? 'yine politikayla denetlenir' : 'still checked by policy');
    expect(text).toContain(locale === 'tr' ? '2,00 $' : '$2.00'); expect(text).toContain('owner-purchase');
  }
});
it.each(['en', 'tr'] as const)('a proposal card shows the system-checked task set apart from the advisory list it never evaluates (%s)', locale => {
  const permissions = [{ kind: 'task', action: 'execute', resourceId: 'task' }, { kind: 'scope', action: 'inspect', resourceId: 'live' },
    { kind: 'model-invocation', action: 'invoke', resourceId: 'gpt-6.1-sol' }];
  const text = renderRunCreateApprovalSummary({ ...command, proposal: { ...command.proposal!, requiredPermissions: permissions } }, create, verdict, locale);
  expect(text).toContain(locale === 'tr' ? 'Başlarken politika her görevin çalıştırma iznini denetler (1 görev)' : 'Checked by policy at the start: permission to run each task (tasks: 1)');
  expect(text).toContain(locale === 'tr' ? 'Önerinin ayrıca andığı izinler (yalnız bilgi, değerlendirilmedi, yetki vermez): 2' : 'Also mentioned by the proposal (advisory, not evaluated, grants nothing): 2');
  expect(text).toContain('scope / inspect / live'); expect(text).toContain('model-invocation / invoke / gpt-6.1-sol'); expect(text).not.toContain('task / execute / task');
});
