import type { RunProposalResult } from '#engine/index.js';
import { currencyAmountText, terminalSafeText, redactForRecord, t, ErrorRegistry, type Locale } from '#platform/index.js';
export function brainProposalLines(result: RunProposalResult, locale: Locale): readonly string[] {
  const record = result.proposal, proposal = record.proposal;
  const statuses = { recorded: t('proposal.status.recorded', {}, locale), pending: t('proposal.status.pending', {}, locale),
    accepted: t('proposal.status.accepted', {}, locale), rejected: t('proposal.status.rejected', {}, locale), parked: t('proposal.status.parked', {}, locale) };
  return [...(result.run ? [t('brain.next', { run: result.run.runId }, locale)] : []),
    t('brain.preview', { run: proposal.runId, status: statuses[record.status] }, locale),
    t('brain.scope', { scope: proposal.scopeId, actor: proposal.proposer.id }, locale),
    ...proposal.graph.tasks.flatMap(task => [t('brain.task', { id: task.id, kind: task.kind, workClass: task.workClass ?? '-', text: task.workInput?.title ?? task.workInput?.task ?? task.id }, locale),
      ...task.acceptanceCriteria.map(id => t('brain.criterion', { text: proposal.graph.criterionDefinitions.find(row => row.id === id)?.description ?? id }, locale))]),
    ...(result.budgetSemantics === 'not-metered' ? [t('proposal.budget.notMetered', {}, locale)] : [
      t('proposal.budget', { amount: currencyAmountText(proposal.budgetCeiling.limitMinorUnits, proposal.budgetCeiling.currency, locale),
        status: record.binding.admission ? t('proposal.budget.checked', {}, locale) : t('proposal.budget.unchecked', {}, locale) }, locale),
      t('proposal.budget.notice', {}, locale)]),
    ...planningSpendingLines(result, locale),
    t('brain.permissions', { permissions: proposal.requiredPermissions.map(row => `${row.kind}/${row.action}/${row.resourceId}`).join(', ') || '-' }, locale),
    ...(record.reason && record.reason !== 'RUN_APPROVAL_REQUIRED' ? [ErrorRegistry.createError(record.reason, { locale }).message] : []),
    ...(record.approval ? [t('brain.waiting', { id: record.approval.approvalId, expires: new Date(record.approval.expiresAt).toISOString() }, locale), t('brain.revise', {}, locale)] : []),
    ...(proposal.source.kind === 'model' ? [t('brain.contribution', { model: proposal.source.receipt.reference.modelId, invocation: proposal.source.receipt.invocationId, template: proposal.source.contribution?.template.version ?? '-' }, locale)] : []),
  ];
}

/** Shared optional Brain-call observation for every proposal summary; worker spend stays separate. */
export function planningSpendingLines(result: RunProposalResult, locale: Locale): readonly string[] {
  const source = result.proposal.proposal.source;
  if (source.kind !== 'model') return [];
  const spending = result.planningSpending, unknown = t('proposal.planning.unknown', {}, locale);
  const classes = { metered: t('proposal.planning.metered', {}, locale), 'not-metered': t('proposal.planning.notMetered', {}, locale), unknown };
  const evidence = { 'measured-tariff-upper-bound': t('proposal.planning.measured-tariff-upper-bound', {}, locale), 'measured-tariff': t('proposal.planning.measured-tariff', {}, locale), 'provider-reported': t('proposal.planning.provider-reported', {}, locale),
    'settled-local': t('proposal.planning.settled-local', {}, locale), 'plan-usage': t('proposal.planning.plan-usage', {}, locale), held: t('proposal.planning.held', {}, locale), unknown };
  const axis = spending?.billingAxis;
  if (axis === 'subscription') return [t('proposal.planning.subscription', { model: terminalSafeText(redactForRecord(`${source.receipt.reference.providerId}/${source.receipt.reference.modelId}`)),
    evidence: evidence[spending?.evidence ?? 'unknown'] }, locale)];
  return [...(axis ? [t('billing.axis', { axis: { subscription: t('billing.subscription', {}, locale), local: t('billing.local', {}, locale), metered: t('billing.metered', {}, locale) }[axis] }, locale)] : []), t('proposal.planning', { model: terminalSafeText(redactForRecord(`${source.receipt.reference.providerId}/${source.receipt.reference.modelId}`)),
    class: classes[spending?.class ?? 'unknown'],
    cost: spending?.amountMinorUnits != null && spending.currency ? `≈${currencyAmountText(spending.amountMinorUnits, spending.currency, locale)}` : unknown,
    evidence: evidence[spending?.evidence ?? 'unknown'] }, locale)];
}
