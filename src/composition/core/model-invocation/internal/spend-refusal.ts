import { ProviderSpendError, ProviderSpendAccountInspectionApplication, ProviderSpendAccountPolicyAuthorization } from '#engine/index.js';
import { openSqliteProviderSpendAccountReader } from '#adapters/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import type { loadInvocationContext } from './context.js';

/** Invocation authority never grants account inspection. Only a fresh governed read can enrich the public refusal. */
export async function modelSpendRefusal(context: Awaited<ReturnType<typeof loadInvocationContext>>, scopeId: string, error: unknown): Promise<never> {
  if (!(error instanceof ProviderSpendError) || error.code !== 'PROVIDER_SPEND_EXHAUSTED' || !error.amounts) throw queryFailure(error);
  const current = await new ProviderSpendAccountInspectionApplication({ async verify() { return context.principal; } },
    new ProviderSpendAccountPolicyAuthorization(context.policy), async () => openSqliteProviderSpendAccountReader(await context.path(),
      { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs })).inspect({ schemaVersion: 1, scopeId, current: true }).catch(() => undefined);
  // Denied or unavailable reads disclose no retained totals.
  throw queryFailure(error, current?.checkpoint?.account);
}
