import { z } from 'zod';
import { immutableJsonObjectSchema, PROVIDER_SPEND_SCOPE_BUDGET_ID, providerSpendBudgetSchema, providerSpendQuoteSchema,
  type ModelBindingDefinition, type ModelInvocationCommand, type ModelInvocationProfile,
  type ProviderSpendBudget, type ProviderSpendQuote } from '#domain/index.js';
import { ProviderSpendError, providerSpendQuoteDigest, providerSpendHasZeroTariff, providerSpendLocalZeroTariff, assertProviderSpendCapacity, createProviderSpendAccount, type ProviderSpendAccountReader } from '#engine/core/provider-spend/index.js';
import { isDeepStrictEqual } from 'node:util';

export interface ModelInvocationSpendingInput {
  readonly command: ModelInvocationCommand;
  readonly requestDigest: string;
  readonly profile: ModelInvocationProfile;
  readonly profileDigest: string;
  readonly definition: ModelBindingDefinition;
  readonly prepared: unknown;
}
export interface ModelInvocationSpending {
  readonly budget: ProviderSpendBudget | null;
  readonly quote: ProviderSpendQuote;
}
/** Trusted composition-owned source, never a model answer or a public command field.
 * Resolve current budget authority and a native-verified bound without credentials or transport effects.
 * A guessed maximum, or a digest of that guess, is not verification of provider billing.
 * Do not mutate command/profile/definition or the adapter-owned prepared token. Quote evaluation is pure
 * and repeatable; the second evaluation verifies the exact first snapshot rather than replacing it.
 */
export interface ModelInvocationSpendingAuthority {
  authorize(input: ModelInvocationSpendingInput, signal?: AbortSignal): Promise<ModelInvocationSpending>;
  /** Read-only account capacity for preview; the real send still reserves atomically under its owner. */
  checkCapacity?(spending: ModelInvocationSpending): Promise<void>;
}
/** Observe the same account capacity the atomic claim checks; no account initialization, reservation or settlement.
 * A budget-less (local zero-tariff) call has no capacity, but an existing frozen scope account still refuses it, as the claim does. */
export async function checkModelInvocationCapacity(open: () => Promise<ProviderSpendAccountReader>, { budget, quote }: ModelInvocationSpending): Promise<void> {
  if (!budget && !providerSpendHasZeroTariff(quote)) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const reader = await open();
  try {
    if (!budget) {
      const snapshot = await reader.loadSnapshot({ schemaVersion: 1, scopeId: quote.scopeId, budgetId: PROVIDER_SPEND_SCOPE_BUDGET_ID, budgetRevision: 1 });
      if (snapshot.checkpoint?.account.frozen) throw new ProviderSpendError('PROVIDER_SPEND_FROZEN');
      return;
    }
    const snapshot = await reader.loadSnapshot({ schemaVersion: 1, scopeId: budget.scopeId, budgetId: budget.budgetId, budgetRevision: budget.revision });
    const account = snapshot.checkpoint?.account ?? createProviderSpendAccount(budget);
    if (!isDeepStrictEqual(account.budget, budget)) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
    assertProviderSpendCapacity(account, quote);
  } finally { reader.close(); }
}
const spendingSchema = immutableJsonObjectSchema.pipe(z.object({
  budget: providerSpendBudgetSchema.nullable(), quote: providerSpendQuoteSchema,
}).strict().readonly());

export async function authorizeModelInvocationSpending(authority: ModelInvocationSpendingAuthority | undefined,
  input: ModelInvocationSpendingInput, signal?: AbortSignal): Promise<ModelInvocationSpending> {
  if (!authority) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  let result: unknown;
  try { result = await boundedAuthorization(authority, Object.freeze(input), signal); }
  catch (error) {
    if (error instanceof ProviderSpendError) throw error;
    throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  }
  const parsed = spendingSchema.safeParse(result);
  if (!parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const { budget, quote } = parsed.data;
  providerSpendQuoteDigest(quote);
  if ((!budget && !providerSpendLocalZeroTariff(input.profile, quote)) || (budget && (budget.scopeId !== input.command.scopeId || budget.currency !== quote.currency)) || quote.scopeId !== input.command.scopeId || quote.requestDigest !== input.requestDigest
    || quote.profileDigest !== input.profileDigest) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  // A null budget is admitted only for a literal zero tariff on literal loopback endpoints (PROVIDER-LOCALITY); the claim still checks a freeze.
  // The atomic account reservation owns exhaustion: its refusal carries settled and outstanding totals.
  return parsed.data;
}

/** A stuck pure quote resolver cannot retain the caller forever or hide cancellation.
 * Late resolution has no continuation into claim/send; the source contract forbids external effects.
 */
async function boundedAuthorization(authority: ModelInvocationSpendingAuthority,
  input: ModelInvocationSpendingInput, signal?: AbortSignal): Promise<unknown> {
  const timeout = new AbortController();
  const bounded = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  if (bounded.aborted) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  const timer = setTimeout(() => timeout.abort(), Math.min(input.profile.limits.timeoutMs, 2_147_483_647));
  timer.unref();
  try {
    return await new Promise((resolve, reject) => {
      const abort = () => { reject(new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE')); };
      bounded.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => {
        if (bounded.aborted) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
        return authority.authorize(input, bounded);
      }).then(resolve, reject).finally(() => bounded.removeEventListener('abort', abort));
    });
  } finally { clearTimeout(timer); }
}
