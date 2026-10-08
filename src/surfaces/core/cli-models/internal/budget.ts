import { createHash, randomUUID } from 'node:crypto';
import { PROVIDER_SPEND_SCOPE_BUDGET_ID, parseProviderSpendManagementCommand, type ProviderSpendManagementCommand } from '#domain/index.js';
import type { ProviderSpendAccountInspection, ProviderSpendManagementResult } from '#engine/index.js';
import { ErrorRegistry, t, type Locale } from '#platform/index.js';
import choices from './budget-choices.json' with { type: 'json' };

/**
 * Stage 1 scope budget choices (owner 2026-10-08): one shared USD limit per scope across every API provider, chosen from presets or stepped
 * within bounds — never typed. Mutable data (`budget-choices.json`); the CLI `--usd` takes the same bounds.
 */
export const SCOPE_BUDGET_CHOICES: Readonly<{ presetsUsd: readonly number[]; minUsd: number; maxUsd: number; stepUsd: number; minorUnitsPerUsd: number }> = Object.freeze(choices);
export type ScopeBudgetSurface = 'cli' | 'terminal';

/** Whole dollars within the bounds, or null. */
export function scopeBudgetUsd(value: unknown): number | null {
  const usd = typeof value === 'string' && /^[1-9]\d{0,6}$/u.test(value) ? Number(value) : value;
  return typeof usd === 'number' && Number.isSafeInteger(usd) && usd >= SCOPE_BUDGET_CHOICES.minUsd && usd <= SCOPE_BUDGET_CHOICES.maxUsd ? usd : null;
}
/** The evidence of an interactive choice is the choice itself (who chose where is in the receipt's actor and authorization). */
const choiceDigest = (input: Readonly<Record<string, unknown>>) => createHash('sha256').update(JSON.stringify({ schemaVersion: 1, kind: 'operator-budget-choice', ...input })).digest('hex');
const budgetOf = (scopeId: string, budgetId: string, revision: number, usd: number) => ({ schemaVersion: 1, scopeId, budgetId, revision, currency: 'USD', limitMinorUnits: usd * SCOPE_BUDGET_CHOICES.minorUnitsPerUsd });

/** `budget-create`: the scope's first account (revision 1) under the shared budget id. */
export function scopeBudgetCreateCommand(scopeId: string, usd: number, surface: ScopeBudgetSurface, commandId: string = `budget-${randomUUID()}`): ProviderSpendManagementCommand {
  return parseProviderSpendManagementCommand({ schemaVersion: 1, kind: 'budget-create', scopeId, commandId, budgetId: PROVIDER_SPEND_SCOPE_BUDGET_ID, budgetRevision: 1,
    budget: budgetOf(scopeId, PROVIDER_SPEND_SCOPE_BUDGET_ID, 1, usd), evidenceDigest: choiceDigest({ surface, scopeId, limitUsd: usd, unfreeze: false }) });
}
/** `budget-revision` of the account a current inspection read: the next revision, the same id and currency (USD only here). */
export function scopeBudgetRevisionCommand(current: ProviderSpendAccountInspection, usd: number, unfreeze: boolean, surface: ScopeBudgetSurface,
  commandId: string = `budget-${randomUUID()}`): ProviderSpendManagementCommand {
  if (!current.checkpoint) throw ErrorRegistry.createError('PROVIDER_SPEND_BUDGET_ABSENT', { params: { scope: current.scopeId } });
  const budget = current.checkpoint.account.budget;
  if (budget.currency !== 'USD') throw ErrorRegistry.createError('PROVIDER_SPEND_CONFLICT');
  return parseProviderSpendManagementCommand({ schemaVersion: 1, kind: 'budget-revision', scopeId: current.scopeId, commandId, budgetId: budget.budgetId,
    budgetRevision: budget.revision, expectedCheckpointDigest: current.checkpoint.digest, budget: budgetOf(current.scopeId, budget.budgetId, budget.revision + 1, usd),
    unfreeze, evidenceDigest: choiceDigest({ surface, scopeId: current.scopeId, limitUsd: usd, unfreeze }) });
}
/** The one summary line of a recorded budget change (CLI text output and the terminal's system line). */
export function scopeBudgetLine(result: ProviderSpendManagementResult, locale: Locale): string {
  const budget = result.receipt.after.budget, usd = (budget.limitMinorUnits / SCOPE_BUDGET_CHOICES.minorUnitsPerUsd).toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: 2 });
  const command = result.receipt.command, values = { scope: budget.scopeId, usd, revision: budget.revision };
  return [command.kind === 'budget-create' ? t('models.budget.created', values, locale) : t('models.budget.revised', values, locale), ...(command.kind === 'budget-revision' && command.unfreeze ? [t('models.budget.unfrozen', {}, locale)] : []),
    ...(result.replayed ? [t('models.budget.replayed', {}, locale)] : [])].join(' ');
}
