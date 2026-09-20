import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { counterSchema, providerSpendBudgetSchema, providerSpendReservationDescriptorSchema } from '#domain/index.js';
import { AttemptStoreError, createProviderSpendCheckpoint, parseProviderSpendAccount, parseProviderSpendReservation,
  providerSpendQuoteDigest, providerSpendReservationDigest, verifyModelInvocationReceipt } from '#engine/index.js';

type Row = Readonly<Record<string, unknown>>;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const oldAccountSchema = z.object({ schemaVersion: z.literal(1), budget: providerSpendBudgetSchema,
  reservedMinorUnits: counterSchema, settledMinorUnits: counterSchema, frozen: z.boolean() }).strict().readonly();
const oldDispositionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('reserved') }).strict(),
  z.object({ state: z.literal('released-not-sent'), evidenceDigest: digestSchema }).strict(),
  z.object({ state: z.literal('settled-local'), amountMinorUnits: counterSchema, evidenceDigest: digestSchema }).strict(),
  z.object({ state: z.literal('held'), reason: z.enum(['unknown', 'missing-usage', 'invalid-usage', 'price-unavailable', 'overrun']),
    observedMinorUnits: counterSchema.nullable(), evidenceDigest: digestSchema }).strict(),
]).readonly();
const oldReservationSchema = z.object({ schemaVersion: z.literal(1), descriptor: providerSpendReservationDescriptorSchema,
  disposition: oldDispositionSchema }).strict().readonly();

function invalid(): never { throw new AttemptStoreError('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); }
function decode(input: unknown): unknown {
  if (typeof input !== 'string') return invalid();
  try { return JSON.parse(input) as unknown; } catch { return invalid(); }
}
function oldHash(prefix: string, value: unknown): string {
  return createHash('sha256').update(`${prefix}\n${JSON.stringify(value)}`).digest('hex');
}
function oldOutcomeDigest(outcome: unknown): string {
  return oldHash('deckent.provider-spend-outcome.v1', outcome);
}

/** Ledger21 replaces integer-only spend records after proving the complete ledger20 monetary history. */
export function migrateProviderReportedSpend(db: DatabaseSync): void {
  try {
    const updateAccount = db.prepare(`UPDATE provider_spend_accounts SET record=?,digest=?
      WHERE scope_id=? AND revision=? AND reservation_count=? AND digest=?`);
    const updateReservation = db.prepare(`UPDATE model_invocation_spend_reservations SET record=?,digest=?
      WHERE scope_id=? AND invocation_id=? AND digest=?`);
    let accountCount = 0, reservationCount = 0;
    for (const accountRow of db.prepare(`SELECT scope_id,revision,reservation_count,digest,record
      FROM provider_spend_accounts ORDER BY scope_id COLLATE BINARY`).iterate() as Iterable<Row>) {
      const parsedAccount = oldAccountSchema.safeParse(decode(accountRow['record']));
      if (!parsedAccount.success) invalid();
      const account = parsedAccount.data, revision = accountRow['revision'], count = accountRow['reservation_count'];
      if (accountRow['scope_id'] !== account.budget.scopeId || !counterSchema.positive().safeParse(revision).success
        || !counterSchema.safeParse(count).success || (revision as number) < (count as number)
        || BigInt(account.reservedMinorUnits) + BigInt(account.settledMinorUnits) > BigInt(account.budget.limitMinorUnits)
        || accountRow['record'] !== JSON.stringify(account)
        || accountRow['digest'] !== oldHash('deckent.provider-spend-checkpoint.v1', { revision, reservationCount: count, account })) invalid();

      let actualCount = 0, reserved = 0n, settled = 0n, overrun = false;
      const rows = db.prepare(`SELECT s.scope_id,s.invocation_id,s.digest,s.record,i.record AS invocation_record
        FROM model_invocation_spend_reservations s LEFT JOIN model_invocations i
        ON i.scope_id=s.scope_id AND i.invocation_id=s.invocation_id
        WHERE s.scope_id=? ORDER BY s.invocation_id COLLATE BINARY`).iterate(account.budget.scopeId) as Iterable<Row>;
      for (const row of rows) {
        const parsedReservation = oldReservationSchema.safeParse(decode(row['record']));
        if (!parsedReservation.success || typeof row['invocation_record'] !== 'string') invalid();
        const reservation = parsedReservation.data, descriptor = reservation.descriptor, state = reservation.disposition;
        const receipt = verifyModelInvocationReceipt(decode(row['invocation_record']));
        if (row['scope_id'] !== descriptor.scopeId || row['invocation_id'] !== descriptor.invocationId
          || account.budget.scopeId !== descriptor.scopeId || account.budget.budgetId !== descriptor.budgetId
          || account.budget.revision !== descriptor.budgetRevision || account.budget.currency !== descriptor.currency
          || descriptor.quoteDigest !== providerSpendQuoteDigest(descriptor.quote)
          || row['record'] !== JSON.stringify(reservation)
          || row['digest'] !== oldHash('deckent.provider-spend-reservation.v1', reservation)
          || receipt.claim.scopeId !== descriptor.scopeId || receipt.claim.invocationId !== descriptor.invocationId
          || receipt.claim.requestDigest !== descriptor.quote.requestDigest || receipt.claim.profileDigest !== descriptor.quote.profileDigest
          || (state.state === 'settled-local' && state.amountMinorUnits > descriptor.quote.maxChargeMinorUnits)
          || (state.state === 'held' && (state.reason === 'overrun'
            ? state.observedMinorUnits === null || state.observedMinorUnits <= descriptor.quote.maxChargeMinorUnits
            : state.observedMinorUnits !== null))) invalid();
        const outcome = receipt.outcome;
        if (state.state === 'reserved') {
          if (outcome !== null) invalid();
        } else if (outcome === null || state.evidenceDigest !== oldOutcomeDigest(outcome)
          || (state.state === 'released-not-sent' ? outcome.state !== 'not-sent' : outcome.state === 'not-sent')
          || (state.state === 'settled-local' && outcome.state === 'unknown')) invalid();
        actualCount++; reservationCount++;
        if (state.state === 'reserved' || state.state === 'held') reserved += BigInt(descriptor.quote.maxChargeMinorUnits);
        if (state.state === 'settled-local') settled += BigInt(state.amountMinorUnits);
        if (state.state === 'held' && state.reason === 'overrun') overrun = true;
      }
      if (actualCount !== count || reserved !== BigInt(account.reservedMinorUnits)
        || settled !== BigInt(account.settledMinorUnits) || account.frozen !== overrun) invalid();
      const translationRows = db.prepare(`SELECT scope_id,invocation_id,digest,record
        FROM model_invocation_spend_reservations WHERE scope_id=? ORDER BY invocation_id COLLATE BINARY`)
        .iterate(account.budget.scopeId) as Iterable<Row>;
      for (const row of translationRows) {
        const old = oldReservationSchema.safeParse(decode(row['record']));
        if (!old.success || row['digest'] !== oldHash('deckent.provider-spend-reservation.v1', old.data)) invalid();
        const next = parseProviderSpendReservation({ ...old.data, schemaVersion: 2, measurement: null });
        if (updateReservation.run(JSON.stringify(next), providerSpendReservationDigest(next),
          row['scope_id'] as string, row['invocation_id'] as string, row['digest'] as string).changes !== 1) invalid();
      }
      const nextAccount = parseProviderSpendAccount({ ...account, schemaVersion: 2,
        settledExactMinorUnits: String(account.settledMinorUnits) });
      const checkpoint = createProviderSpendCheckpoint(nextAccount, revision as number, count as number);
      if (updateAccount.run(JSON.stringify(nextAccount), checkpoint.digest, account.budget.scopeId,
        revision as number, count as number, accountRow['digest'] as string).changes !== 1) invalid();
      accountCount++;
    }
    if (db.prepare('SELECT count(*) AS count FROM provider_spend_accounts').get()?.count !== accountCount
      || db.prepare('SELECT count(*) AS count FROM model_invocation_spend_reservations').get()?.count !== reservationCount
      || db.prepare('PRAGMA foreign_key_check').all().length !== 0) invalid();
  } catch (error) {
    if (error instanceof AttemptStoreError && error.code === 'LEDGER_MIGRATION_EVIDENCE_REQUIRED') throw error;
    invalid();
  }
}
