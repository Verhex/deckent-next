import { z } from 'zod';
import { immutableJsonObjectSchema, providerSpendBudgetSchema, providerSpendQuoteSchema,
  type ModelBindingDefinition, type ModelInvocationCommand, type ModelInvocationProfile,
  type ProviderSpendBudget, type ProviderSpendQuote } from '#domain/index.js';
import { ProviderSpendError, providerSpendQuoteDigest } from '#engine/core/provider-spend/index.js';

export interface ModelInvocationSpendingInput {
  readonly command: ModelInvocationCommand;
  readonly requestDigest: string;
  readonly profile: ModelInvocationProfile;
  readonly profileDigest: string;
  readonly definition: ModelBindingDefinition;
  readonly prepared: unknown;
}
export interface ModelInvocationSpending {
  readonly budget: ProviderSpendBudget;
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
}
const spendingSchema = immutableJsonObjectSchema.pipe(z.object({
  budget: providerSpendBudgetSchema, quote: providerSpendQuoteSchema,
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
  if (budget.scopeId !== input.command.scopeId || quote.scopeId !== input.command.scopeId
    || budget.currency !== quote.currency || quote.requestDigest !== input.requestDigest
    || quote.profileDigest !== input.profileDigest) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  if (quote.maxChargeMinorUnits > budget.limitMinorUnits) throw new ProviderSpendError('PROVIDER_SPEND_EXHAUSTED');
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
