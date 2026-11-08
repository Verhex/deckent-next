import { advisoryProposalPermissions, dependencyTaskId, getPolicyVocabulary, isConflictEdge, isRecognisedProposalPermission, resolveTaskWorkClass,
  type PolicyDecision, type ProposalPermissionCatalog, type TaskAgentSeal, type WorkClassRegistry, type WorkerAssignment } from '#domain/index.js';
import { currencyAmountText, redactForRecord, shortId, terminalSafeText, t, type KnownSecretSnapshot, type Locale } from '#platform/index.js';
import type { BoundRunAdmission } from './admission.js';
import type { RunCreate } from './store.js';
import limits from './approval-summary-limits.json' with { type: 'json' };

// Versioned display bounds only; neither the DAG nor permissions are shortened for admission.
const field = (raw: string, max: number, known?: KnownSecretSnapshot): string => {
  const clean = redactForRecord(terminalSafeText(redactForRecord(raw, known)), known).replace(/\s+/gu, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
};

/** ATAMA-1: the worker the system chose for a task (sealed in the admission input the person approves) and the listed ones it skipped; F2-12: how it was chosen goes under details. */
function assignmentRows(assignment: WorkerAssignment | undefined, locale: Locale, known?: KnownSecretSnapshot, agent?: TaskAgentSeal): { head: string[]; detail: string[] } {
  const chosen = agent ? [t('agent.card.selected', { agentId: field(agent.agentId, limits.assignmentChars, known), revision: agent.revision, standing: agent.standing === 'active' ? t('agent.standing.active', {}, locale) : t('agent.standing.candidate', {}, locale) }, locale)] : []; // S8-1b
  if (!assignment) return { head: chosen, detail: [] };
  const worker = t('assignment.card.worker', { modelId: field(assignment.modelId, limits.assignmentChars, known), channelId: field(assignment.channelId, limits.assignmentChars, known) }, locale);
  const how = t('assignment.card.workerChoice', { effort: assignment.effort.level ?? t('assignment.effort.cliDefault', {}, locale), workClass: field(assignment.workClass, limits.workClassChars, known),
    policy: field(`${assignment.candidatePolicy.id}@${assignment.candidatePolicy.version}`, limits.workClassChars, known), position: assignment.candidateIndex + 1 }, locale), sel = 'selector' in assignment ? assignment.selector : undefined;
  return { head: [...chosen, worker], detail: [how, ...(sel ? [t('assignment.card.selector', { position: sel.position + 1, expanded: sel.expanded, revision: field(sel.roleRevision, limits.workClassChars, known) }, locale)] : []),
    ...(assignment.skipped.length ? [t('assignment.card.skipped', { skipped: field(assignment.skipped.map(row => `${row.modelId} (${row.reason})`).join(', '), limits.assignmentChars, known) }, locale)] : [])] };
}
/** One catalog for the person's refusal and the model's 'unrecognised (advisory)' marker, so the two paths cannot diverge (accept_mark). */
export function runProposalPermissionCatalog(registry: WorkClassRegistry | undefined): ProposalPermissionCatalog {
  return [...getPolicyVocabulary().resources, ...(resolveTaskWorkClass('', undefined, registry).policy.proposalPermissions ?? [])];
}

/** One producer renderer for all approval observers; derived only from the input and basis the authority decision seals.
 * `askedAtExecution`: tasks whose task restriction requires approval; TaskApprovalAdmission asks each once, when it runs (g4-cift-onay).
 * F2-12 (owner: a short plan card): the head says each task's title, its worker and the mode ceiling with one note; the rest follows under "Details". */
export function renderRunCreateApprovalSummary(command: BoundRunAdmission, create: RunCreate, verdict: PolicyDecision,
  locale: Locale = 'en', known?: KnownSecretSnapshot, registry?: WorkClassRegistry, askedAtExecution: readonly string[] = []): string {
  // A proposal's checked set is system-derived from the graph; its own list is advisory only (live 2026-10-18) and shown as such.
  const tasks = create.graph.tasks, permissions = command.proposal ? advisoryProposalPermissions(command.proposal.requiredPermissions, command.graph) : undefined;
  const unknown = t('approval.plan.undeclared', {}, locale), executionOf = (id: string) => create.execution.tasks.find(row => row.taskId === id);
  const taskTitle = (task: (typeof tasks)[number]) => field(task.workInput?.title ?? task.workInput?.task ?? task.id, limits.titleChars, known), assigned = tasks.slice(0, limits.taskRows).map(task => ({ task, rows: assignmentRows(executionOf(task.id)?.assignment, locale, known, executionOf(task.id)?.agent) }));
  const taskRows = assigned.map(({ task, rows }) => [t('approval.plan.task', { title: taskTitle(task) }, locale), ...rows.head].join('\n'));
  const taskDetailRows = assigned.map(({ task, rows }, index) => [t('approval.plan.taskDetail', { n: index + 1, kind: field(task.kind, limits.taskKindChars, known),
    workClass: field(executionOf(task.id)?.acceptance?.workClass ?? task.workClass ?? task.workInput?.workClass ?? unknown, limits.workClassChars, known) }, locale), ...rows.detail].join('\n'));
  const catalog = runProposalPermissionCatalog(registry); // accept_mark (owner 2026-10-18): an unrecognised model entry is marked, never refused.
  const permissionRows = (permissions ?? []).slice(0, limits.permissionRows).map(permission => {
    const params = { kind: field(permission.kind, limits.permissionKindChars, known), action: field(permission.action, limits.permissionActionChars, known), resource: field(permission.resourceId, limits.permissionResourceChars, known) };
    return isRecognisedProposalPermission(permission, catalog) ? t('approval.plan.permission', params, locale) : t('approval.plan.permission.unrecognised', params, locale);
  });
  // D7a: the system's order edges are part of what the human approves (sealed in the admission input digest); always counted, rows bounded.
  const edges = tasks.flatMap(task => task.dependencies.filter(isConflictEdge).map(edge => ({ task: task.id, after: dependencyTaskId(edge) })));
  const edgeRows = edges.slice(0, limits.edgeRows).map(edge => t('approval.plan.conflictEdge', { task: field(edge.task, limits.titleChars, known), after: field(edge.after, limits.titleChars, known) }, locale));
  const ceiling = command.proposal?.budgetCeiling, metered = command.proposal?.admission?.budgetSemantics !== 'not-metered';
  const title = (id: string) => { const task = tasks.find(row => row.id === id); return field(task?.workInput?.title ?? task?.workInput?.task ?? id, limits.titleChars, known); };
  // g4-cift-onay (owner-approved card text 2026-10-18): a task approval is asked once, when that task runs; the plan card says so instead of asking it here.
  const asked = askedAtExecution.length ? [t('approval.plan.askedAtExecution', { tasks: askedAtExecution.slice(0, limits.taskRows).map(title).join(', ')
    + (askedAtExecution.length > limits.taskRows ? ' ' + t('approval.plan.moreTasks', { count: askedAtExecution.length - limits.taskRows }, locale) : '') }, locale)] : [];
  const checked = command.proposal ? [t('approval.plan.checked', { count: command.graph.tasks.length }, locale)] : [], mode = create.execution.workerMode ? [t('approval.plan.workerMode', { mode: create.execution.workerMode.mode === 'full-auto' ? t('terminal.mode.stop.full-auto', {}, locale) : create.execution.workerMode.askEdits ? t('terminal.mode.stop.ask-edits', {}, locale) : t('terminal.mode.stop.standart', {}, locale) }, locale)] : []; // R9 worker ceiling
  const rule = verdict.ruleId ? field(verdict.ruleId, limits.ruleChars, known) : t('approval.plan.registryGate', {}, locale), required = t('approval.plan.required', {}, locale); // the plain requirement needs no code beside its words
  const decision = verdict.reason === 'APPROVAL_REQUIRED' ? t('approval.plan.decisionRule', { decision: required, rule }, locale) : t('approval.plan.decision', { decision: required, rule, reason: field(verdict.reason, limits.reasonChars, known) }, locale);
  const render = () => [t('approval.plan.tasks', { count: tasks.length }, locale), ...taskRows,
    ...(tasks.length > taskRows.length ? [t('approval.plan.moreTasks', { count: tasks.length - taskRows.length }, locale)] : []),
    ...mode, ...(command.proposal ? asked : []), ...(command.proposal?.delivery ? [t('approval.plan.delivery', { target: field(command.proposal.delivery.target.id, limits.runChars, known) }, locale)] : []),
    ...(metered ? [t('approval.plan.budget', { ceiling: ceiling ? currencyAmountText(ceiling.limitMinorUnits, ceiling.currency, locale) : unknown }, locale)] : []),
    ...(edges.length ? [t('approval.plan.conflictEdges', { count: edges.length }, locale), ...edgeRows] : []),
    ...(edges.length > edgeRows.length ? [t('approval.plan.moreConflictEdges', { count: edges.length - edgeRows.length }, locale)] : []),
    t('approval.plan.authorityNotice', {}, locale),
    t('approval.plan.details', {}, locale), ...taskDetailRows, ...checked,
    t('approval.plan.permissions', { count: permissions?.length ?? unknown }, locale), ...permissionRows,
    ...(permissions && permissions.length > permissionRows.length ? [t('approval.plan.morePermissions', { count: permissions.length - permissionRows.length }, locale)] : []),
    ...(metered ? [t('approval.plan.budgetNotice', {}, locale)] : [t('proposal.budget.notMetered', {}, locale)]) /* R9d: no API ceiling to name */,
    decision, t('approval.plan.run', { run: field(shortId(command.runId), limits.runChars, known) }, locale)].join('\n');
  // Preserve the budget/decision and explicit omitted counts even with unusually long catalog text. Task titles are
  // proposer-authored, so they are dropped before declared permissions: long titles cannot push permissions off the card.
  while (render().length > limits.summaryChars && (taskRows.length || edgeRows.length || permissionRows.length)) {
    if (taskRows.length) { taskRows.pop(); taskDetailRows.pop(); } else if (edgeRows.length) edgeRows.pop(); else permissionRows.pop();
  }
  return render();
}
