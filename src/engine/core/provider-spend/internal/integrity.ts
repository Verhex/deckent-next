import { identitySchema } from '#domain/index.js';
import { parseProviderSpendReservation, type ProviderSpendReservation } from './account.js';
import { parseProviderSpendCheckpoint, type ProviderSpendCheckpoint } from './checkpoint.js';
import { addProviderSpendExactMinorUnits, ceilProviderSpendExactMinorUnits } from './exact.js';
import { ProviderSpendError } from './error.js';

export interface ProviderSpendIntegrityPageQuery {
  readonly scopeId: string;
  readonly checkpoint: ProviderSpendCheckpoint | null;
  readonly afterInvocationId: string | null;
  readonly limit: number;
}
export interface ProviderSpendIntegrityPage {
  readonly checkpoint: ProviderSpendCheckpoint;
  readonly reservations: readonly ProviderSpendReservation[];
  readonly nextInvocationId: string | null;
}
/** A separate read-only path. Each page releases its snapshot before another page is requested. */
export interface ProviderSpendIntegrityReader {
  readPage(query: ProviderSpendIntegrityPageQuery): Promise<ProviderSpendIntegrityPage | null>;
  close(): void;
}
export const PROVIDER_SPEND_INTEGRITY_PAGE_MAX = 1000;
export function validateProviderSpendIntegrityPageSize(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROVIDER_SPEND_INTEGRITY_PAGE_MAX) {
    throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
}
/** A completed result describes exactly one account revision, never a later live balance or permission to spend. */
export async function verifyProviderSpendIntegrity(reader: ProviderSpendIntegrityReader, scopeId: string, pageSize: number, signal?: AbortSignal) {
  if (!identitySchema.safeParse(scopeId).success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  validateProviderSpendIntegrityPageSize(pageSize);
  let checkpoint: ProviderSpendCheckpoint | null = null, cursor: string | null = null;
  let reserved = 0n, settledExact = '0', count = 0, overrun = false;
  for (;;) {
    if (signal?.aborted) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
    const page = await reader.readPage({ scopeId, checkpoint, afterInvocationId: cursor, limit: pageSize });
    if (signal?.aborted) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
    if (!page) {
      if (checkpoint) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      return null;
    }
    const current = parseProviderSpendCheckpoint(page.checkpoint);
    if (current.account.budget.scopeId !== scopeId) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    if (checkpoint && current.digest !== checkpoint.digest) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
    checkpoint = current;
    if (!Array.isArray(page.reservations) || page.reservations.length > pageSize
      || (cursor !== null && page.reservations.length === 0)) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    for (const raw of page.reservations) {
      const reservation = parseProviderSpendReservation(raw), d = reservation.descriptor, budget = current.account.budget;
      if (d.scopeId !== scopeId || d.budgetId !== budget.budgetId || d.budgetRevision !== budget.revision || d.currency !== budget.currency
        || (cursor !== null && Buffer.compare(Buffer.from(d.invocationId), Buffer.from(cursor)) <= 0)) {
        throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
      }
      cursor = d.invocationId; count++;
      if (count > current.reservationCount) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
      const state = reservation.disposition;
      if (state.state === 'reserved' || state.state === 'held') reserved += BigInt(d.quote.maxChargeMinorUnits);
      if (state.state === 'settled-local') settledExact = addProviderSpendExactMinorUnits(settledExact, String(state.amountMinorUnits));
      if (state.state === 'settled-provider-reported') settledExact = addProviderSpendExactMinorUnits(settledExact, reservation.measurement!.exactMinorUnits);
      if (state.state === 'held' && state.reason === 'overrun') overrun = true;
    }
    if (page.nextInvocationId !== null) {
      if (page.reservations.length !== pageSize || page.nextInvocationId !== cursor) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
      continue;
    }
    const account = current.account;
    if (count !== current.reservationCount || reserved !== BigInt(account.reservedMinorUnits)
      || settledExact !== account.settledExactMinorUnits || ceilProviderSpendExactMinorUnits(settledExact) !== account.settledMinorUnits
      || account.frozen !== overrun) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    return Object.freeze({ checkpoint: current, reservationCount: count,
      reservedMinorUnits: Number(reserved), settledMinorUnits: account.settledMinorUnits,
      settledExactMinorUnits: settledExact });
  }
}
