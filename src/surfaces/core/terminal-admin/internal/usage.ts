import { t } from '#platform/index.js';
import { parseProviderSpendAccountQuery } from '#domain/index.js';
import type { SessionUsageView } from '#surfaces/core/terminal-kit/index.js';
import { queryFailureText } from './failure.js';
import { count } from './human.js';
import type { TerminalAdminCall } from './context.js';

/** An unreported reasoning count stays unknown: never a zero, and a partial sum says how many reports it misses. */
function reasoningText(usage: SessionUsageView, locale: TerminalAdminCall['locale']): string {
  if (usage.reasoningUnmeasured === 0) return t('terminal.admin.usage.reasoningMeasured', { tokens: count(usage.reasoningTokens, locale) }, locale);
  if (usage.reasoningUnmeasured >= usage.reports) return t('terminal.admin.usage.reasoningNotMeasured', {}, locale);
  return t('terminal.admin.usage.reasoningPartial', { tokens: count(usage.reasoningTokens, locale), unmeasured: usage.reasoningUnmeasured, reports: usage.reports }, locale);
}

/**
 * `/usage`: what this terminal measured for the open conversation (typed `usage` events; not a bill), or with `<budget-id> <revision>` the
 * provider spend account of that budget through the typed query. A failed spend query shows its typed error, never an earlier figure.
 */
export async function usageLines(call: TerminalAdminCall, args: string, usage: SessionUsageView): Promise<readonly string[]> {
  const { root, scopeId, options, locale, context } = call;
  const words = args.split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return usage.reports === 0 ? [t('terminal.admin.usage.none', {}, locale)]
      : [t('terminal.admin.usage.heading', { reports: usage.reports }, locale), t('terminal.admin.usage.prompt', { tokens: count(usage.promptTokens, locale) }, locale),
        t('terminal.admin.usage.completion', { tokens: count(usage.completionTokens, locale) }, locale), t('terminal.admin.usage.reasoning', { reasoning: reasoningText(usage, locale) }, locale),
        t('terminal.admin.usage.notBilling', {}, locale)];
  }
  let query;
  try { query = parseProviderSpendAccountQuery({ schemaVersion: 1, scopeId, budgetId: words[0], budgetRevision: Number(words[1]) }); }
  catch { return [t('terminal.admin.usage.usage', {}, locale)]; }
  if (words.length !== 2) return [t('terminal.admin.usage.usage', {}, locale)];
  if (!context.inspectProviderSpendAccount) return [t('terminal.admin.partUnavailable', { part: t('terminal.admin.usage.partSpend', {}, locale) }, locale)];
  try {
    const result = await context.inspectProviderSpendAccount(root, query, options);
    if (result.checkpoint === null) return [t('models.spending.absent', { scope: result.scopeId, budget: result.budgetId, revision: result.budgetRevision }, locale), t('models.spending.historyNotRecorded', {}, locale)];
    const { account } = result.checkpoint;
    return [t('models.spending.account', { scope: result.scopeId, budget: result.budgetId, revision: result.budgetRevision, currency: account.budget.currency,
      limit: count(account.budget.limitMinorUnits, locale), checkpoint: result.checkpoint.revision, reservations: count(result.checkpoint.reservationCount, locale) }, locale),
    t('models.spending.reserved', { amount: count(account.reservedMinorUnits, locale), currency: account.budget.currency }, locale),
    t('models.spending.settledExact', { amount: count(account.settledExactMinorUnits, locale), currency: account.budget.currency }, locale),
    t('models.spending.frozen', { value: account.frozen ? t('models.spending.frozenYes', {}, locale) : t('models.spending.frozenNo', {}, locale) }, locale),
    t('terminal.admin.usage.notBilling', {}, locale)];
  } catch (error) { return [t('terminal.admin.partFailed', { part: t('terminal.admin.usage.partSpend', {}, locale), reason: queryFailureText(error, locale) }, locale)]; }
}
