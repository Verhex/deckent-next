import { isRunIntentResult, type RunPlanningResult, type RunIntentResult, type RunProposalResult } from '#engine/index.js';
import { advisoryProposalPermissions, deriveProposalPermissions } from '#domain/index.js';
import { currencyAmountText, terminalSafeText, redactForRecord, t, ErrorRegistry, type Locale } from '#platform/index.js';
const permissionText = (rows: ReturnType<typeof deriveProposalPermissions>) => terminalSafeText(rows.map(row => `${row.kind}/${row.action}/${row.resourceId}`).join(', ')) || '-';
export function brainProposalLines(result: RunPlanningResult, locale: Locale): readonly string[] {
  if (isRunIntentResult(result)) return runIntentLines(result, locale);
  const record = result.proposal, proposal = record.proposal, unrecognised = result.unrecognisedPermissions ?? [];
  // Unrecognised entries get their own advisory line (accept_mark, owner 2026-10-18); every entry appears once.
  const marked = new Set(unrecognised.map(row => JSON.stringify(row))), advisory = advisoryProposalPermissions(proposal.requiredPermissions, proposal.graph).filter(row => !marked.has(JSON.stringify(row)));
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
    // The system derives what admission evaluates; the proposer's own list is shown apart as advisory (live 2026-10-18).
    t('brain.permissions', { permissions: permissionText(deriveProposalPermissions(proposal.graph)) }, locale),
    ...(!advisory.length ? [] : proposal.source.kind === 'model' ? [t('brain.permissions.advisory.model', { permissions: permissionText(advisory) }, locale)]
      : [t('brain.permissions.advisory.human', { permissions: permissionText(advisory) }, locale)]),
    ...(unrecognised.length ? [t('proposal.permissions.unrecognised', { permissions: permissionText(unrecognised) }, locale)] : []),
    ...(record.reason && record.reason !== 'RUN_APPROVAL_REQUIRED' ? [ErrorRegistry.createError(record.reason, { locale, ...(result.reasonParams ? { params: result.reasonParams } : {}) }).message] : []),
    ...(record.approval ? [t('brain.waiting', { id: record.approval.approvalId, expires: new Date(record.approval.expiresAt).toISOString() }, locale), t('brain.revise', {}, locale)] : []),
    ...(proposal.source.kind === 'model' ? [t('brain.contribution', { model: proposal.source.receipt.reference.modelId, invocation: proposal.source.receipt.invocationId, template: proposal.source.contribution?.template.version ?? '-' }, locale)] : []),
    ...planningMemoryLines(result, locale),
  ];
}
/** S4B-6: what project memory the planning call used (counts only, never which entries); nothing when memory is off or on a replay. */
export function planningMemoryLines(result: RunProposalResult, locale: Locale): readonly string[] {
  const memory = result.planningMemory;
  if (!memory) return [];
  if (memory.reason) return [{ policy: t('brain.memory.withheld.policy', {}, locale), contests: t('brain.memory.withheld.contests', {}, locale),
    template: t('brain.memory.withheld.template', {}, locale) }[memory.reason]];
  const selected = memory.mode === 'on' ? t('brain.memory.sent', { count: memory.selected }, locale) : t('brain.memory.shadow', { count: memory.selected }, locale);
  return [...(memory.selected ? [selected] : []),
    ...(memory.omitted ? [t('brain.memory.omitted', { count: memory.omitted }, locale)] : []),
    ...(memory.withheld ? [t('brain.memory.withheld.sources', { count: memory.withheld }, locale)] : [])];
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

/** Intent states never masquerade as a planned graph, a Run, a grant or a settled unknown start. */
export function runIntentLines(result: RunIntentResult, locale: Locale): readonly string[] {
  const intent = result.intent, states = { parked: t('onboarding.parked.status.parked', {}, locale), released: t('onboarding.parked.status.released', {}, locale),
    starting: t('onboarding.parked.status.starting', {}, locale), cancelled: t('onboarding.parked.status.cancelled', {}, locale) };
  return [t('onboarding.parked.state', { state: states[intent.status], command: intent.command.commandId }, locale),
    ...(intent.status === 'cancelled' ? [t('onboarding.parked.cancelled', {}, locale)] : intent.status === 'released'
      ? [t('onboarding.parked.released', {}, locale)] : [ErrorRegistry.createError(intent.fact.reason, { locale, params: intent.fact.params }).message])];
}
