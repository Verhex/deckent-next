import { createHash } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, immutableJsonObjectSchema } from '#domain/index.js';
import { parseProviderSpendAccount, parseProviderSpendReservation, ProviderSpendError, type ProviderSpendAccount } from './account.js';

export interface ProviderSpendCheckpoint {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly reservationCount: number;
  readonly account: ProviderSpendAccount;
  readonly digest: string;
}
const schema = immutableJsonObjectSchema.pipe(z.object({ schemaVersion: z.literal(1), revision: counterSchema.positive(),
  reservationCount: counterSchema, account: z.unknown(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
function hash(account: ProviderSpendAccount, revision: number, reservationCount: number): string {
  return createHash('sha256').update(`deckent.provider-spend-checkpoint.v1\n${JSON.stringify({ revision, reservationCount, account })}`).digest('hex');
}
/** Corruption checksum, not authentication against someone who can rewrite the ledger. */
export function createProviderSpendCheckpoint(accountInput: unknown, revision: number, reservationCount: number): ProviderSpendCheckpoint {
  const account = parseProviderSpendAccount(accountInput);
  if (!counterSchema.positive().safeParse(revision).success || !counterSchema.safeParse(reservationCount).success
    || revision < reservationCount) {
    throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
  return Object.freeze({ schemaVersion: 1, revision, reservationCount, account, digest: hash(account, revision, reservationCount) });
}
export function parseProviderSpendCheckpoint(input: unknown): ProviderSpendCheckpoint {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const expected = createProviderSpendCheckpoint(parsed.data.account, parsed.data.revision, parsed.data.reservationCount);
  if (parsed.data.digest !== expected.digest) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return expected;
}
export function providerSpendReservationDigest(input: unknown): string {
  return createHash('sha256').update(`deckent.provider-spend-reservation.v1\n${JSON.stringify(parseProviderSpendReservation(input))}`).digest('hex');
}
