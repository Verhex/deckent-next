import { z } from 'zod';
import { immutableJsonObjectSchema, parseProviderSpendAccountQuery, PROVIDER_SPEND_SCOPE_BUDGET_ID,
  type ProviderSpendAccountQuery, type ProviderSpendExactAccountQuery } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { parseProviderSpendAuditReceipt, type ProviderSpendAuditReceipt } from './audit-receipt.js';
import { parseProviderSpendCheckpoint, type ProviderSpendCheckpoint } from './checkpoint.js';
import { ProviderSpendError } from './error.js';

export interface ProviderSpendAccountAuthorizer {
  authorize(action: 'inspect', target: Readonly<{ scopeId: string; budgetId: string; budgetRevision: number }>,
    principal: Awaited<ReturnType<typeof authenticate>>): Promise<unknown>;
}
export interface ProviderSpendAccountReader {
  loadSnapshot(query: ProviderSpendExactAccountQuery): Promise<Readonly<{
    checkpoint: ProviderSpendCheckpoint | null; audit: ProviderSpendAuditReceipt | null;
  }>>;
  close(): void;
}
/** Settled totals may combine local calculations and provider-reported charges; source subtotals are not exposed.
 * Reserved amounts include held reservations; hold-reason breakdown is not exposed. Neither total is an invoice.
 * reservationCount counts financial records, not model-call quota. Checksums do not constitute a history audit. */
export type ProviderSpendAccountInspection = Readonly<{ schemaVersion: 2; scopeId: string; budgetId: string;
  budgetRevision: number; checkpoint: ProviderSpendCheckpoint | null; audit: ProviderSpendAuditReceipt | null;
  spendingHistoryIntegrity: 'not-recorded' | 'consistent' | 'stale' }>;

const resultSchema = immutableJsonObjectSchema.pipe(z.object({ schemaVersion: z.literal(2), scopeId: z.string(),
  budgetId: z.string(), budgetRevision: z.number(), checkpoint: z.unknown().nullable(),
  audit: z.unknown().nullable(), spendingHistoryIntegrity: z.enum(['not-recorded', 'consistent', 'stale']) }).strict().readonly());

export function parseProviderSpendAccountInspectionForQuery(queryInput: unknown, resultInput: unknown): ProviderSpendAccountInspection {
  let query: ProviderSpendAccountQuery;
  try { query = parseProviderSpendAccountQuery(queryInput); }
  catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
  const parsed = resultSchema.safeParse(resultInput);
  if (!parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  // A current query (stage 1) answers with the account's own id and revision, or the id a create would write (revision 1) when there is none.
  if ('current' in query) query = { schemaVersion: 1, scopeId: query.scopeId, ...(parsed.data.checkpoint === null
    ? { budgetId: PROVIDER_SPEND_SCOPE_BUDGET_ID, budgetRevision: 1 } : { budgetId: parsed.data.budgetId, budgetRevision: parsed.data.budgetRevision }) };
  if (parsed.data.scopeId !== query.scopeId || parsed.data.budgetId !== query.budgetId
    || parsed.data.budgetRevision !== query.budgetRevision) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  if (parsed.data.checkpoint === null) {
    if (parsed.data.audit !== null || parsed.data.spendingHistoryIntegrity !== 'not-recorded') {
      throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    }
    return Object.freeze({ ...parsed.data, checkpoint: null, audit: null });
  }
  const checkpoint = parseProviderSpendCheckpoint(parsed.data.checkpoint), budget = checkpoint.account.budget;
  if (budget.scopeId !== query.scopeId || budget.budgetId !== query.budgetId
    || budget.revision !== query.budgetRevision) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  const audit = parsed.data.audit === null ? null : parseProviderSpendAuditReceipt(parsed.data.audit);
  if (audit && (audit.command.scopeId !== query.scopeId || audit.command.budgetId !== query.budgetId
    || audit.command.budgetRevision !== query.budgetRevision)) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  const expected = audit === null ? 'not-recorded'
    : audit.examinedCheckpoint.digest === checkpoint.digest ? 'consistent' : 'stale';
  if (parsed.data.spendingHistoryIntegrity !== expected) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return Object.freeze({ ...parsed.data, checkpoint, audit });
}

export class ProviderSpendAccountInspectionApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ProviderSpendAccountAuthorizer,
    private readonly openReader: () => Promise<ProviderSpendAccountReader>) {}
  async inspect(input: unknown, credential?: unknown): Promise<ProviderSpendAccountInspection> {
    let query: ProviderSpendAccountQuery;
    try { query = parseProviderSpendAccountQuery(input); }
    catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
    const principal = await authenticate(this.verifier, credential, query.scopeId);
    const authorize = (exact: ProviderSpendExactAccountQuery) => this.authorization.authorize('inspect', { scopeId: exact.scopeId, budgetId: exact.budgetId,
      budgetRevision: exact.budgetRevision }, principal);
    // An exact query is authorized before storage opens (unchanged).
    if (!('current' in query)) await authorize(query);
    let reader: ProviderSpendAccountReader;
    try { reader = await this.openReader(); }
    catch { throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE'); }
    let snapshot: Awaited<ReturnType<ProviderSpendAccountReader['loadSnapshot']>>, exact: ProviderSpendExactAccountQuery, authorizing = false;
    try {
      // Stage 1 current query: the checkpoint is scope-keyed, so a first read names the account; it is authorized and read again exactly.
      if ('current' in query) {
        const first = await reader.loadSnapshot({ schemaVersion: 1, scopeId: query.scopeId, budgetId: PROVIDER_SPEND_SCOPE_BUDGET_ID, budgetRevision: 1 });
        exact = { schemaVersion: 1, scopeId: query.scopeId, budgetId: first.checkpoint?.account.budget.budgetId ?? PROVIDER_SPEND_SCOPE_BUDGET_ID,
          budgetRevision: first.checkpoint?.account.budget.revision ?? 1 };
        authorizing = true; await authorize(exact); authorizing = false;
      } else exact = query;
      snapshot = await reader.loadSnapshot(exact);
    } catch (error) {
      try { reader.close(); } catch { /* preserve the read failure */ }
      // A policy refusal of the resolved account stays the policy's own error.
      if (authorizing || error instanceof ProviderSpendError) throw error;
      throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
    }
    try { reader.close(); }
    catch { throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE'); }
    const spendingHistoryIntegrity = snapshot.audit === null ? 'not-recorded'
      : snapshot.checkpoint !== null && snapshot.audit.examinedCheckpoint.digest === snapshot.checkpoint.digest ? 'consistent' : 'stale';
    // A budget that moved between the two reads is reported, never mixed (the result names one exact revision).
    const moved = snapshot.checkpoint && (snapshot.checkpoint.account.budget.budgetId !== exact.budgetId || snapshot.checkpoint.account.budget.revision !== exact.budgetRevision);
    if ('current' in query && moved) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
    return parseProviderSpendAccountInspectionForQuery(query, { schemaVersion: 2, scopeId: exact.scopeId,
      budgetId: exact.budgetId, budgetRevision: exact.budgetRevision, ...snapshot, spendingHistoryIntegrity });
  }
}
