import { loadConfig, t } from '#platform/index.js';
import { type InfoSection, type InfoView } from '#surfaces/core/terminal-window/index.js';
import { parseProviderSpendAccountQuery } from '#domain/index.js';
import { SCOPE_BUDGET_CHOICES } from '#surfaces/core/cli-models/index.js';
import type { SessionUsageView } from '#surfaces/core/terminal-kit/index.js';
import { queryFailureText } from './failure.js';
import { count } from './human.js';
import type { TerminalAdminCall } from './context.js';
import USAGE_DISPLAY from './usage-display.json' with { type: 'json' };

/** `netBenefitUsdE10` is USD x 1e10 (tokens x rate units of 0.0001 USD per million tokens). */
const USD_E10 = 1e10;

/** An unreported reasoning count stays unknown: never a zero, and a partial sum says how many reports it misses. */
function reasoningText(usage: SessionUsageView, locale: TerminalAdminCall['locale']): string {
  if (usage.reasoningUnmeasured === 0) return t('terminal.admin.usage.reasoningMeasured', { tokens: count(usage.reasoningTokens, locale) }, locale);
  if (usage.reasoningUnmeasured >= usage.reports) return t('terminal.admin.usage.reasoningNotMeasured', {}, locale);
  return t('terminal.admin.usage.reasoningPartial', { tokens: count(usage.reasoningTokens, locale), unmeasured: usage.reasoningUnmeasured, reports: usage.reports }, locale);
}

function cacheRows(usage: SessionUsageView, locale: TerminalAdminCall['locale']): NonNullable<InfoSection['rows']> {
  const measured = usage.cache?.reports ?? 0, partial = measured < usage.reports;
  const amount = (tokens: number) => measured === 0 ? t('terminal.info.usage.cacheNone', {}, locale)
    : partial ? t('terminal.info.usage.cachePartial', { tokens: count(tokens, locale), measured, reports: usage.reports }, locale)
    : t('terminal.info.usage.tokens', { tokens: count(tokens, locale) }, locale);
  const cache = usage.cache, percent = cache?.promptTokens ? (100 * cache.readTokens / cache.promptTokens).toFixed(1) : null;
  const hit = percent === null ? t('terminal.info.usage.cacheNone', {}, locale)
    : partial ? t('terminal.info.usage.cacheHitPartial', { percent, measured, reports: usage.reports }, locale)
    : t('terminal.info.usage.cacheHit', { percent, read: count(cache!.readTokens, locale), prompt: count(cache!.promptTokens, locale) }, locale);
  return [{ key: t('terminal.info.usage.key.cacheRead', {}, locale), value: amount(cache?.readTokens ?? 0) },
    { key: t('terminal.info.usage.key.cacheWrite', {}, locale), value: amount(cache?.writeTokens ?? 0) },
    // CACHE-SLICE1: the raw TTL classes of the writes (a write the provider reported without its TTL split is only in the total above).
    { key: t('terminal.info.usage.key.cacheWrite5m', {}, locale), value: amount(cache?.write5mTokens ?? 0) },
    { key: t('terminal.info.usage.key.cacheWrite1h', {}, locale), value: amount(cache?.write1hTokens ?? 0) },
    { key: t('terminal.info.usage.key.cacheHit', {}, locale), value: hit },
    { key: t('terminal.info.usage.key.cacheBenefit', {}, locale), value: benefitText(cache, usage.reports, locale) }];
}
/** CACHE-SLICE1: the same-request net cache benefit in USD (read savings minus the write premium, at each request's own rates); an estimate, never a
 * bill, and a negative value is shown as it is. Reports without a measured benefit keep the figure partial. */
function benefitText(cache: SessionUsageView['cache'], total: number, locale: TerminalAdminCall['locale']): string {
  const reports = cache?.benefitReports ?? 0;
  if (!cache || reports === 0) return t('terminal.info.usage.cacheNone', {}, locale);
  const digits = USAGE_DISPLAY.cacheBenefitFractionDigits;
  const usd = (cache.netBenefitUsdE10 / USD_E10).toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const text = t('terminal.info.usage.money', { amount: usd, currency: 'USD' }, locale);
  return reports < total ? t('terminal.info.usage.cacheBenefitPartial', { amount: text, measured: reports, reports: total }, locale)
    : t('terminal.info.usage.cacheBenefit', { amount: text }, locale);
}

/**
 * `/usage`: what this terminal measured for the open conversation (typed `usage` events; not a bill), or with `<budget-id> <revision>` the
 * provider spend account of that budget through the typed query. A failed spend query shows its typed error, never an earlier figure.
 */
export async function usageLines(call: TerminalAdminCall, args: string, usage: SessionUsageView): Promise<readonly string[]> {
  const { root, scopeId, options, locale, context } = call;
  const words = args.split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    const { model } = await usageView(call, usage);
    return model.sections.flatMap(section => [...(section.title ? [section.title] : []), ...(section.rows ?? []).map(row => `${row.key}: ${row.value}`),
      ...(section.choices ?? []).map(choice => `${choice.label}${choice.detail ? ` · ${choice.detail}` : ''}`), ...(section.notes ?? [])]);
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

/** FOLLOWUPS 2026-10-09 item 5: a USD account reads in dollars (the registry's minor units per USD), keeping an exact sub-cent amount's digits;
 * another currency keeps its minor units. */
function money(amount: number | string | bigint, currency: string, locale: TerminalAdminCall['locale']): string {
  const value = Number(amount);
  if (currency !== 'USD' || !Number.isFinite(value)) return t('terminal.info.usage.minor', { amount: count(amount, locale), currency }, locale);
  const text = (value / SCOPE_BUDGET_CHOICES.minorUnitsPerUsd).toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US', { minimumFractionDigits: 2,
    maximumFractionDigits: 2 + (String(amount).split('.')[1] ?? '').length });
  return t('terminal.info.usage.money', { amount: text, currency }, locale);
}

type Budget = Readonly<{ budgetId: string; revision: number; currency: string; limitMinorUnits: number }>;
/** The spend budgets this scope's configuration declares (`provider_spending.budgets`), read as data: the picker's source, not an authority. */
function scopeBudgets(config: Readonly<Record<string, unknown>>, scopeId: string): readonly Budget[] {
  const budgets = (config['provider_spending'] as { budgets?: unknown } | undefined)?.budgets;
  if (!Array.isArray(budgets)) return [];
  return budgets.flatMap(entry => {
    const value = entry as Partial<Budget & { scopeId: string }>;
    return value && value.scopeId === scopeId && typeof value.budgetId === 'string' && Number.isInteger(value.revision) && typeof value.currency === 'string'
      && typeof value.limitMinorUnits === 'number' ? [{ budgetId: value.budgetId, revision: value.revision!, currency: value.currency, limitMinorUnits: value.limitMinorUnits }] : [];
  });
}

/** One spend account through the typed query, as a section; a failed or unwired query names itself and shows no figure. */
async function accountSection(call: TerminalAdminCall, budget: Budget | null): Promise<InfoSection> {
  const { root, scopeId, options, locale, context } = call;
  let title = budget ? t('terminal.info.usage.section.account', { budget: budget.budgetId }, locale) : t('terminal.info.usage.section.live', {}, locale);
  if (!context.inspectProviderSpendAccount) return { title, chip: { state: 'neutral', text: t('terminal.info.chip.unavailable', {}, locale) }, notes: [t('terminal.admin.partUnavailable', { part: t('terminal.admin.usage.partSpend', {}, locale) }, locale)] };
  try {
    const result = await context.inspectProviderSpendAccount(root, parseProviderSpendAccountQuery(budget ? { schemaVersion: 1, scopeId, budgetId: budget.budgetId, budgetRevision: budget.revision } : { schemaVersion: 1, scopeId, current: true }), options);
    if (result.checkpoint === null) return { title, chip: { state: 'warn', text: t('terminal.info.usage.chip.noSnapshot', {}, locale) },
      notes: [t('models.spending.absent', { scope: result.scopeId, budget: result.budgetId, revision: result.budgetRevision }, locale)] };
    const { account } = result.checkpoint, currency = account.budget.currency, minor = (amount: number | string | bigint) => money(amount, currency, locale);
    if (!budget) title = t('terminal.info.usage.section.live', {}, locale);
    return { title, chip: account.frozen ? { state: 'warn', text: t('terminal.info.usage.chip.frozen', {}, locale) } : { state: 'ok', text: t('terminal.info.usage.chip.open', {}, locale) }, rows: [
      { key: t('terminal.info.usage.key.budget', {}, locale), value: account.budget.budgetId },
      { key: t('terminal.info.usage.key.revision', {}, locale), value: String(account.budget.revision) },
      { key: t('terminal.info.usage.key.limit', {}, locale), value: minor(account.budget.limitMinorUnits) },
      { key: t('terminal.info.usage.key.reserved', {}, locale), value: minor(account.reservedMinorUnits) },
      { key: t('terminal.info.usage.key.settled', {}, locale), value: minor(account.settledExactMinorUnits) },
      { key: t('terminal.info.usage.key.remaining', {}, locale), value: minor(Math.max(0, account.budget.limitMinorUnits - account.settledMinorUnits - account.reservedMinorUnits)) },
      { key: t('terminal.info.usage.key.frozen', {}, locale), value: account.frozen ? t('models.spending.frozenYes', {}, locale) : t('models.spending.frozenNo', {}, locale) },
      { key: t('terminal.info.usage.key.reservations', {}, locale), value: count(result.checkpoint.reservationCount, locale) },
      { key: t('terminal.info.usage.key.checkpoint', {}, locale), value: String(result.checkpoint.revision) }], notes: [t('terminal.admin.usage.notBilling', {}, locale)] };
  } catch (error) {
    return { title, chip: { state: 'fail', text: t('terminal.info.chip.notRead', {}, locale) }, notes: [t('terminal.admin.partFailed', { part: t('terminal.admin.usage.partSpend', {}, locale), reason: queryFailureText(error, locale) }, locale)] };
  }
}

/**
 * `/usage` as a window (SW-1): what this terminal measured for the open conversation, and the scope's spend budgets as a list to pick from
 * (no typed budget id or revision); picking one reads that account through the typed query and shows it in the same window.
 */
export async function usageView(call: TerminalAdminCall, usage: SessionUsageView): Promise<InfoView> {
  const { root, scopeId, options, locale } = call;
  const conversation: InfoSection = usage.reports === 0 ? { title: t('terminal.info.usage.section.conversation', {}, locale), notes: [t('terminal.admin.usage.none', {}, locale)] }
    : { title: t('terminal.info.usage.section.conversation', {}, locale), rows: [{ key: t('terminal.info.usage.key.reports', {}, locale), value: count(usage.reports, locale) },
      { key: t('terminal.info.usage.key.prompt', {}, locale), value: t('terminal.info.usage.tokens', { tokens: count(usage.promptTokens, locale) }, locale) },
      { key: t('terminal.info.usage.key.completion', {}, locale), value: t('terminal.info.usage.tokens', { tokens: count(usage.completionTokens, locale) }, locale) },
      { key: t('terminal.info.usage.key.reasoning', {}, locale), value: reasoningText(usage, locale), ...(usage.reasoningUnmeasured ? { chip: { state: 'neutral' as const, text: t('terminal.info.chip.unknown', {}, locale) } } : {}) }, ...cacheRows(usage, locale)],
    notes: [t('terminal.admin.usage.notBilling', {}, locale)] };
  const budgetsTitle = t('terminal.info.usage.section.budgets', {}, locale);
  let budgets: readonly Budget[] = [], budgetSection: InfoSection;
  try {
    budgets = scopeBudgets(await loadConfig(root, options), scopeId);
    budgetSection = budgets.length ? { title: budgetsTitle, choices: budgets.map((budget, index) => ({ id: `budget-${index}`,
      label: t('terminal.info.usage.budgetChoice', { budget: budget.budgetId, limit: money(budget.limitMinorUnits, budget.currency, locale) }, locale),
      detail: t('terminal.info.usage.budgetRevision', { revision: budget.revision }, locale) })), notes: [t('terminal.info.usage.pick', {}, locale)] }
      : { title: budgetsTitle, notes: [t('terminal.info.usage.noBudgets', {}, locale)] };
  } catch (error) {
    budgetSection = { title: budgetsTitle, chip: { state: 'fail', text: t('terminal.info.chip.notRead', {}, locale) }, notes: [t('terminal.admin.partFailed', { part: budgetsTitle, reason: queryFailureText(error, locale) }, locale)] };
  }
  const summary = usage.reports === 0 ? t('terminal.info.usage.summaryNone', {}, locale)
    : t('terminal.info.usage.summary', { prompt: count(usage.promptTokens, locale), completion: count(usage.completionTokens, locale), reports: count(usage.reports, locale) }, locale);
  const base = { title: t('terminal.info.usage.title', {}, locale), summary };
  const live = await accountSection(call, null);
  const view = (account: InfoSection | null): InfoView => ({ model: { ...base, sections: [live, conversation, budgetSection, ...(account ? [account] : [])] }, pick: async choice => {
    const budget = budgets[Number(choice.slice('budget-'.length))];
    return budget && choice.startsWith('budget-') ? view(await accountSection(call, budget)) : null;
  } });
  return view(null);
}
