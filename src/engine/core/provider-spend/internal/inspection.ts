import { z } from 'zod';
import { immutableJsonObjectSchema, parseProviderSpendAccountQuery,
  type ProviderSpendAccountQuery } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { parseProviderSpendCheckpoint, type ProviderSpendCheckpoint } from './checkpoint.js';
import { ProviderSpendError } from './error.js';

export interface ProviderSpendAccountAuthorizer {
  authorize(action: 'inspect', target: Readonly<{ scopeId: string; budgetId: string; budgetRevision: number }>,
    principal: Awaited<ReturnType<typeof authenticate>>): Promise<unknown>;
}
export interface ProviderSpendAccountReader {
  loadSnapshot(scopeId: string): Promise<ProviderSpendCheckpoint | null>;
  close(): void;
}
/** Settled totals may combine local calculations and provider-reported charges; source subtotals are not exposed.
 * Reserved amounts include held reservations; hold-reason breakdown is not exposed. Neither total is an invoice.
 * reservationCount counts financial records, not model-call quota. Checksums do not constitute a history audit. */
export type ProviderSpendAccountInspection = Readonly<{ schemaVersion: 1; scopeId: string; budgetId: string;
  budgetRevision: number; checkpoint: ProviderSpendCheckpoint | null; spendingHistoryIntegrity: 'not-recorded' }>;

const resultSchema = immutableJsonObjectSchema.pipe(z.object({ schemaVersion: z.literal(1), scopeId: z.string(),
  budgetId: z.string(), budgetRevision: z.number(), checkpoint: z.unknown().nullable(),
  spendingHistoryIntegrity: z.literal('not-recorded') }).strict().readonly());

export function parseProviderSpendAccountInspectionForQuery(queryInput: unknown, resultInput: unknown): ProviderSpendAccountInspection {
  let query: ProviderSpendAccountQuery;
  try { query = parseProviderSpendAccountQuery(queryInput); }
  catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
  const parsed = resultSchema.safeParse(resultInput);
  if (!parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  if (parsed.data.scopeId !== query.scopeId || parsed.data.budgetId !== query.budgetId
    || parsed.data.budgetRevision !== query.budgetRevision) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  if (parsed.data.checkpoint === null) return Object.freeze({ ...parsed.data, checkpoint: null });
  const checkpoint = parseProviderSpendCheckpoint(parsed.data.checkpoint), budget = checkpoint.account.budget;
  if (budget.scopeId !== query.scopeId || budget.budgetId !== query.budgetId
    || budget.revision !== query.budgetRevision) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  return Object.freeze({ ...parsed.data, checkpoint });
}

export class ProviderSpendAccountInspectionApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ProviderSpendAccountAuthorizer,
    private readonly openReader: () => Promise<ProviderSpendAccountReader>) {}
  async inspect(input: unknown, credential?: unknown): Promise<ProviderSpendAccountInspection> {
    let query: ProviderSpendAccountQuery;
    try { query = parseProviderSpendAccountQuery(input); }
    catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
    const principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorization.authorize('inspect', { scopeId: query.scopeId,
      budgetId: query.budgetId, budgetRevision: query.budgetRevision }, principal);
    let reader: ProviderSpendAccountReader;
    try { reader = await this.openReader(); }
    catch { throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE'); }
    let checkpoint: ProviderSpendCheckpoint | null;
    try { checkpoint = await reader.loadSnapshot(query.scopeId); }
    catch (error) {
      try { reader.close(); } catch { /* preserve the read failure */ }
      if (error instanceof ProviderSpendError) throw error;
      throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
    }
    try { reader.close(); }
    catch { throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE'); }
    return parseProviderSpendAccountInspectionForQuery(query, { schemaVersion: 1, scopeId: query.scopeId,
      budgetId: query.budgetId, budgetRevision: query.budgetRevision, checkpoint,
      spendingHistoryIntegrity: 'not-recorded' });
  }
}
