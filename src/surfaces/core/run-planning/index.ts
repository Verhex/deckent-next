import type { RunProposalResult } from '#engine/index.js';
import { t, ErrorRegistry, type Locale } from '#platform/index.js';
export function brainProposalLines(result: RunProposalResult, locale: Locale): readonly string[] {
  const record = result.proposal, proposal = record.proposal;
  const statuses = { recorded: t('proposal.status.recorded', {}, locale), pending: t('proposal.status.pending', {}, locale),
    accepted: t('proposal.status.accepted', {}, locale), rejected: t('proposal.status.rejected', {}, locale), parked: t('proposal.status.parked', {}, locale) };
  return [t('brain.preview', { run: proposal.runId, status: statuses[record.status] }, locale),
    t('brain.scope', { scope: proposal.scopeId, actor: proposal.proposer.id }, locale),
    ...proposal.graph.tasks.flatMap(task => [t('brain.task', { id: task.id, kind: task.kind, workClass: task.workClass ?? '-', text: task.workInput?.title ?? task.workInput?.task ?? task.id }, locale),
      ...task.acceptanceCriteria.map(id => t('brain.criterion', { text: proposal.graph.criterionDefinitions.find(row => row.id === id)?.description ?? id }, locale))]),
    t('proposal.budget', { currency: proposal.budgetCeiling.currency, amount: proposal.budgetCeiling.limitMinorUnits, status: record.binding.admission ? t('proposal.budget.checked', {}, locale) : t('proposal.budget.unchecked', {}, locale) }, locale),
    t('proposal.budget.notice', {}, locale),
    t('brain.permissions', { permissions: proposal.requiredPermissions.map(row => `${row.kind}/${row.action}/${row.resourceId}`).join(', ') || '-' }, locale),
    ...(record.reason && record.reason !== 'RUN_APPROVAL_REQUIRED' ? [ErrorRegistry.createError(record.reason, { locale }).message] : []),
    ...(record.approval ? [t('brain.waiting', { id: record.approval.approvalId, expires: new Date(record.approval.expiresAt).toISOString() }, locale), t('brain.revise', {}, locale)] : []),
    ...(proposal.source.kind === 'model' ? [t('brain.contribution', { model: proposal.source.receipt.reference.modelId, invocation: proposal.source.receipt.invocationId, template: proposal.source.contribution?.template.version ?? '-' }, locale)] : []),
    ...(result.run ? [t('brain.next', { run: result.run.runId }, locale)] : []),
  ];
}
