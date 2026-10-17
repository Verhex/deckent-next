import { advisoryProposalPermissions, type PolicyDecision } from '#domain/index.js';
import { currencyAmountText, redactForRecord, terminalSafeText, t, type KnownSecretSnapshot, type Locale } from '#platform/index.js';
import type { BoundRunAdmission } from './admission.js';
import type { RunCreate } from './store.js';

import limits from './approval-summary-limits.json' with { type: 'json' };

// Versioned display bounds only; neither the DAG nor permissions are shortened for admission.
const field = (raw: string, max: number, known?: KnownSecretSnapshot): string => {
  const clean = redactForRecord(terminalSafeText(redactForRecord(raw, known)), known).replace(/\s+/gu, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
};

/** One producer renderer for all approval observers; derived only from the input and basis the authority decision seals. */
export function renderRunCreateApprovalSummary(command: BoundRunAdmission, create: RunCreate, verdict: PolicyDecision,
  locale: Locale = 'en', known?: KnownSecretSnapshot): string {
  // A proposal's checked set is system-derived from the graph; its own list is advisory only (live 2026-10-18) and shown as such.
  const tasks = create.graph.tasks, permissions = command.proposal ? advisoryProposalPermissions(command.proposal.requiredPermissions, command.graph) : undefined;
  const unknown = t('approval.plan.undeclared', {}, locale);
  const taskRows = tasks.slice(0, limits.taskRows).map(task => t('approval.plan.task', {
    title: field(task.workInput?.title ?? task.workInput?.task ?? task.id, limits.titleChars, known),
    kind: field(task.kind, limits.taskKindChars, known), workClass: field(create.execution.tasks.find(row => row.taskId === task.id)?.acceptance?.workClass
      ?? task.workClass ?? task.workInput?.workClass ?? unknown, limits.workClassChars, known),
  }, locale));
  const permissionRows = (permissions ?? []).slice(0, limits.permissionRows).map(permission => t('approval.plan.permission', {
    kind: field(permission.kind, limits.permissionKindChars, known), action: field(permission.action, limits.permissionActionChars, known), resource: field(permission.resourceId, limits.permissionResourceChars, known),
  }, locale));
  const ceiling = command.proposal?.budgetCeiling;
  const checked = command.proposal ? [t('approval.plan.checked', { count: command.graph.tasks.length }, locale)] : [];
  const footer = [t('approval.plan.permissions', { count: permissions?.length ?? unknown }, locale), t('approval.plan.authorityNotice', {}, locale),
    t('approval.plan.budget', { ceiling: ceiling ? currencyAmountText(ceiling.limitMinorUnits, ceiling.currency, locale) : unknown }, locale),
    command.proposal?.admission?.budgetSemantics === 'not-metered' ? t('proposal.budget.notMetered', {}, locale) : t('approval.plan.budgetNotice', {}, locale),
    t('approval.plan.decision', { decision: t('approval.plan.required', {}, locale),
      rule: verdict.ruleId ? field(verdict.ruleId, limits.ruleChars, known) : t('approval.plan.registryGate', {}, locale), reason: field(verdict.reason, limits.reasonChars, known) }, locale),
    t('approval.plan.run', { run: field(command.runId, limits.runChars, known) }, locale)];
  const render = () => [t('approval.plan.tasks', { count: tasks.length }, locale), ...taskRows,
    ...(tasks.length > taskRows.length ? [t('approval.plan.moreTasks', { count: tasks.length - taskRows.length }, locale)] : []),
    ...checked, footer[0]!, ...permissionRows,
    ...(permissions && permissions.length > permissionRows.length ? [t('approval.plan.morePermissions', { count: permissions.length - permissionRows.length }, locale)] : []),
    ...footer.slice(1)].join('\n');
  // Preserve the budget/decision and explicit omitted counts even with unusually long catalog text. Task titles are
  // proposer-authored, so they are dropped before declared permissions: long titles cannot push permissions off the card.
  while (render().length > limits.summaryChars && (taskRows.length || permissionRows.length)) {
    if (taskRows.length) taskRows.pop(); else permissionRows.pop();
  }
  return render();
}
