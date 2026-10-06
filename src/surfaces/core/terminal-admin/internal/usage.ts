import { t } from '#platform/index.js';
import { parseProviderSpendAccountQuery } from '#domain/index.js';
import type { SessionUsageView } from '#surfaces/core/terminal-kit/index.js';
import { queryFailureText } from './failure.js';
import type { TerminalAdminCall } from './context.js';

/**
 * `/usage`: what this terminal measured for the open conversation (typed `usage` events; not a bill), or with `<budget-id> <revision>` the
 * provider spend account of that budget through the typed query. A failed spend query shows its typed error, never an earlier figure.
 */
export async function usageLines(call: TerminalAdminCall, args: string, usage: SessionUsageView): Promise<readonly string[]> {
  const { root, scopeId, options, locale, context } = call;
  const words = args.split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return usage.reports === 0 ? [t('terminal.admin.usage.none', {}, locale)]
      : [t('terminal.admin.usage.session', { reports: usage.reports, prompt: usage.promptTokens, completion: usage.completionTokens, reasoning: usage.reasoningTokens }, locale),
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
      limit: account.budget.limitMinorUnits, checkpoint: result.checkpoint.revision, reservations: result.checkpoint.reservationCount }, locale),
    t('models.spending.reserved', { amount: account.reservedMinorUnits, currency: account.budget.currency }, locale),
    t('models.spending.settledExact', { amount: account.settledExactMinorUnits, currency: account.budget.currency }, locale),
    t('models.spending.frozen', { value: account.frozen ? t('models.spending.frozenYes', {}, locale) : t('models.spending.frozenNo', {}, locale) }, locale),
    t('terminal.admin.usage.notBilling', {}, locale)];
  } catch (error) { return [t('terminal.admin.partFailed', { part: t('terminal.admin.usage.partSpend', {}, locale), reason: queryFailureText(error, locale) }, locale)]; }
}
