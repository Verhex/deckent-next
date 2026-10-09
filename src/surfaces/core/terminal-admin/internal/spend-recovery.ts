import { createHash, randomUUID } from 'node:crypto';
import { t, type Params } from '#platform/index.js';
import { parseProviderSpendManagementCommand, PROVIDER_SPEND_HOLD_PAGE_MAX } from '#domain/index.js';
import { SCOPE_BUDGET_CHOICES, scopeBudgetLine, scopeBudgetRevisionCommand, type ProviderSpendAccountInspectionHandler } from '#surfaces/core/cli-models/index.js';
import type { InfoView } from '#surfaces/core/terminal-window/index.js';
import type { TerminalAdminCall } from './context.js';
import { queryFailureText } from './failure.js';
type ProviderSpendAccountInspection = Awaited<ReturnType<ProviderSpendAccountInspectionHandler>>;

export function spendMoney(minor: number | string, currency: string, call: Pick<TerminalAdminCall, 'locale'>): string {
  if (currency !== 'USD') return t('terminal.info.usage.minor', { amount: String(minor), currency }, call.locale);
  const [whole = '0', fraction = ''] = String(minor).split('.');
  const units = BigInt(SCOPE_BUDGET_CHOICES.minorUnitsPerUsd), integer = BigInt(whole);
  const usd = (integer / units).toLocaleString(call.locale);
  const cents = (integer % units).toString().padStart(String(SCOPE_BUDGET_CHOICES.minorUnitsPerUsd).length - 1, '0');
  const digits = (cents + fraction).replace(/0+$/u, '').padEnd(2, '0');
  const separator = new Intl.NumberFormat(call.locale).formatToParts(1.1).find(part => part.type === 'decimal')!.value;
  return t('terminal.info.usage.money', { amount: `${usd}${separator}${digits}`, currency }, call.locale);
}
const phrases = {
  'title': (params: Params, call: TerminalAdminCall) => t('terminal.spend.title', params, call.locale),
  'totals': (params: Params, call: TerminalAdminCall) => t('terminal.spend.totals', params, call.locale),
  'reconcile': (params: Params, call: TerminalAdminCall) => t('terminal.spend.reconcile', params, call.locale),
  'budget': (params: Params, call: TerminalAdminCall) => t('terminal.spend.budget', params, call.locale),
  'unavailable': (params: Params, call: TerminalAdminCall) => t('terminal.spend.unavailable', params, call.locale),
  'currencyUnsupported': (params: Params, call: TerminalAdminCall) => t('terminal.spend.currencyUnsupported', params, call.locale),
  'budgetConfirm': (params: Params, call: TerminalAdminCall) => t('terminal.spend.budgetConfirm', params, call.locale),
  'confirm': (params: Params, call: TerminalAdminCall) => t('terminal.spend.confirm', params, call.locale),
  'uncertain': (params: Params, call: TerminalAdminCall) => t('terminal.spend.uncertain', params, call.locale),
  'empty': (params: Params, call: TerminalAdminCall) => t('terminal.spend.empty', params, call.locale),
  'more': (params: Params, call: TerminalAdminCall) => t('terminal.spend.more', params, call.locale),
  'writeOffWarning': (params: Params, call: TerminalAdminCall) => t('terminal.spend.writeOffWarning', params, call.locale),
  'writeOff': (params: Params, call: TerminalAdminCall) => t('terminal.spend.writeOff', params, call.locale),
  'done': (params: Params, call: TerminalAdminCall) => t('terminal.spend.done', params, call.locale),
  'reason.unknown': (params: Params, call: TerminalAdminCall) => t('terminal.spend.reason.unknown', params, call.locale),
  'reason.missing-usage': (params: Params, call: TerminalAdminCall) => t('terminal.spend.reason.missing-usage', params, call.locale),
  'reason.invalid-usage': (params: Params, call: TerminalAdminCall) => t('terminal.spend.reason.invalid-usage', params, call.locale),
  'reason.price-unavailable': (params: Params, call: TerminalAdminCall) => t('terminal.spend.reason.price-unavailable', params, call.locale),
  'reason.overrun': (params: Params, call: TerminalAdminCall) => t('terminal.spend.reason.overrun', params, call.locale),
};
const words = (call: TerminalAdminCall, key: keyof typeof phrases, params: Params = {}) => phrases[key](params, call);
const read = (call: TerminalAdminCall, afterInvocationId: string | null = null) => call.context.inspectProviderSpendAccount!(call.root,
  { schemaVersion: 2, scopeId: call.scopeId, current: true, holds: { afterInvocationId, limit: PROVIDER_SPEND_HOLD_PAGE_MAX } }, call.options);
function message(call: TerminalAdminCall, text: string): InfoView { return { model: { title: words(call, 'title'), sections: [{ notes: [text] }], summary: text } }; }
function summary(call: TerminalAdminCall, current: ProviderSpendAccountInspection): string {
  const account = current.checkpoint!.account, money = (minor: number | string) => spendMoney(minor, account.budget.currency, call);
  return words(call, 'totals', { settled: money(account.settledExactMinorUnits), held: money(account.reservedMinorUnits), limit: money(account.budget.limitMinorUnits) });
}
/** No history or provider body reaches the terminal. Each selection carries one exact checkpoint to the existing governed writer. */
export async function spendRecoveryView(call: TerminalAdminCall): Promise<InfoView> {
  if (!call.context.inspectProviderSpendAccount || !call.context.manageProviderSpend) return message(call, words(call, 'unavailable'));
  const current = await call.context.inspectProviderSpendAccount(call.root, { schemaVersion: 1, scopeId: call.scopeId, current: true }, call.options);
  if (!current.checkpoint) return message(call, words(call, 'unavailable'));
  return { model: { summary: '', title: words(call, 'title'), sections: [{ notes: [summary(call, current)], choices: [
    { id: 'reconcile', label: words(call, 'reconcile') }, { id: 'budget', label: words(call, 'budget') }] }] },
    pick: async choice => choice === 'reconcile' ? heldView(call, await read(call)) : choice === 'budget' ? budgetView(call, current) : null };
}
function budgetView(call: TerminalAdminCall, current: ProviderSpendAccountInspection): InfoView {
  if (current.checkpoint!.account.budget.currency !== 'USD') return message(call, words(call, 'currencyUnsupported'));
  return { model: { summary: '', title: words(call, 'budget'), sections: [{ notes: [summary(call, current)], choices: SCOPE_BUDGET_CHOICES.presetsUsd.map(usd => ({ id: String(usd), label: `${usd} USD` })) }] },
    pick: async selected => {
      const usd = SCOPE_BUDGET_CHOICES.presetsUsd.find(value => String(value) === selected);
      if (usd === undefined) return null;
      return { model: { summary: '', title: words(call, 'budgetConfirm', { usd }), sections: [{ choices: [{ id: 'confirm', label: words(call, 'confirm') }] }] },
        pick: async choice => {
          if (choice !== 'confirm') return null;
          try { return message(call, scopeBudgetLine(await call.context.manageProviderSpend!(call.root, scopeBudgetRevisionCommand(current, usd, false, 'terminal'), call.options), call.locale)); }
          catch (error) { return message(call, queryFailureText(error, call.locale)); }
        } };
    } };
}
function heldView(call: TerminalAdminCall, current: ProviderSpendAccountInspection): InfoView {
  const page = current.holds!, account = current.checkpoint?.account;
  if (!account) return message(call, words(call, 'unavailable'));
  return { model: { summary: '', title: words(call, 'reconcile'), sections: [{ notes: [summary(call, current), words(call, 'uncertain'), ...(page.entries.length ? [] : [words(call, 'empty')])],
    choices: [...page.entries.map(entry => ({ id: entry.invocationId, label: entry.invocationId, detail: `${spendMoney(entry.amountMinorUnits, account.budget.currency, call)} · ${words(call, `reason.${entry.reason}`)}` })),
      ...(page.nextAfterInvocationId ? [{ id: ':next', label: words(call, 'more') }] : [])] }] }, pick: async choice => {
      if (choice === ':next' && page.nextAfterInvocationId) return heldView(call, await read(call, page.nextAfterInvocationId));
      const entry = page.entries.find(value => value.invocationId === choice);
      if (!entry) return null;
      return { model: { summary: '', title: words(call, 'reconcile'), sections: [{ notes: [entry.invocationId, words(call, 'writeOffWarning', { amount: spendMoney(entry.amountMinorUnits, account.budget.currency, call) })],
        choices: [{ id: 'write-off', label: words(call, 'writeOff') }] }] }, pick: async answer => {
        if (answer !== 'write-off') return null;
        const evidence = { schemaVersion: 1, kind: 'operator-spend-write-off', scopeId: call.scopeId, invocationId: entry.invocationId,
          checkpointDigest: current.checkpoint!.digest, holdEvidenceDigest: entry.evidenceDigest };
        const command = parseProviderSpendManagementCommand({ schemaVersion: 1, kind: 'reconcile', commandId: `reconcile-${randomUUID()}`, scopeId: call.scopeId,
          budgetId: account.budget.budgetId, budgetRevision: account.budget.revision, expectedCheckpointDigest: current.checkpoint!.digest,
          invocationId: entry.invocationId, resolution: 'write-off', exactMinorUnits: '0', evidence: { kind: 'write-off', digest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') } });
        try { await call.context.manageProviderSpend!(call.root, command, call.options); return message(call, words(call, 'done', { invocationId: entry.invocationId })); }
        catch (error) { return message(call, queryFailureText(error, call.locale)); }
      } };
    } };
}
