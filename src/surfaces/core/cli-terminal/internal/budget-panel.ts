import { loadConfig, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { BudgetPanelPort, BudgetPanelView } from '#surfaces/core/terminal-panels/index.js';
import { SCOPE_BUDGET_CHOICES, scopeBudgetCreateCommand, scopeBudgetLine, scopeBudgetRevisionCommand } from '#surfaces/core/cli-models/index.js';
import type { TerminalLaunchContext } from './context.js';

type Host = Required<Pick<TerminalLaunchContext, 'inspectProviderSpendAccount' | 'manageProviderSpend'>>;
type Configured = Readonly<{ scopeId?: unknown; limitMinorUnits?: unknown; currency?: unknown }>;
const usdOf = (minor: number) => minor / SCOPE_BUDGET_CHOICES.minorUnitsPerUsd;

/**
 * Stage 1 `/model` and `/provider` budget window port (owner 2026-10-08): the scope's current account through the runtime service (`current`
 * inspection), and the governed spend command (`budget-create` / `budget-revision`) built from the chosen amount. Policy, audit and the ledger
 * stay with the service; this port only reads, builds and reports one summary line.
 */
export function budgetPanelPort(root: string, scopeId: string, host: Host, options: ConfigLoadOptions, locale: Locale, errorText: (error: unknown) => string): BudgetPanelPort {
  const current = () => host.inspectProviderSpendAccount(root, { schemaVersion: 1, scopeId, current: true }, options);
  const choices = { presets: SCOPE_BUDGET_CHOICES.presetsUsd, min: SCOPE_BUDGET_CHOICES.minUsd, max: SCOPE_BUDGET_CHOICES.maxUsd, step: SCOPE_BUDGET_CHOICES.stepUsd };
  return {
    async inspect(): Promise<BudgetPanelView> {
      const read = await current(), account = read.checkpoint?.account;
      if (account) {
        const text = t('tui.budget.current', { usd: usdOf(account.budget.limitMinorUnits), revision: account.budget.revision }, locale);
        return { ...choices, action: 'change', current: account.frozen ? `${text} · ${t('tui.budget.frozen', {}, locale)}` : text, note: null, frozen: account.frozen,
          settledUsd: Number(account.settledExactMinorUnits) / SCOPE_BUDGET_CHOICES.minorUnitsPerUsd,
          start: Math.min(choices.max, Math.max(choices.min, Math.round(usdOf(account.budget.limitMinorUnits)))) };
      }
      // A budget declared in configuration opens its account at the first call; a governed create beside it is refused, so no action here.
      const config = await loadConfig(root, options) as Record<string, unknown>;
      const declared = ((config['provider_spending'] as { budgets?: readonly Configured[] } | undefined)?.budgets ?? []).find(budget => budget.scopeId === scopeId);
      if (declared) return { ...choices, action: null, current: null, frozen: false, start: choices.min,
        note: t('tui.budget.configured', { current: `${usdOf(Number(declared.limitMinorUnits))} ${String(declared.currency)}` }, locale) };
      return { ...choices, action: 'create', current: null, note: null, frozen: false, start: choices.presets[0] ?? choices.min };
    },
    async apply(request) {
      try {
        const command = request.action === 'create' ? scopeBudgetCreateCommand(scopeId, request.usd, 'terminal')
          : scopeBudgetRevisionCommand(await current(), request.usd, request.unfreeze, 'terminal');
        return { ok: true, line: scopeBudgetLine(await host.manageProviderSpend(root, command, options), locale) };
      } catch (error) { return { ok: false, line: errorText(error) }; }
    },
  };
}
