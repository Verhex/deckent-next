import { expect, it } from 'vitest';
import { createProviderSpendAccount, createProviderSpendCheckpoint, parseProviderSpendCheckpoint,
  providerSpendQuoteDigest, reserveProviderSpend, verifyProviderSpendIntegrity,
  type ProviderSpendIntegrityPage, type ProviderSpendIntegrityReader } from '#engine/core/provider-spend/index.js';

function fixture() {
  const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'shared', revision: 1, currency: 'USD', limitMinorUnits: 100 };
  let account = createProviderSpendAccount(budget);
  const reservations = ['a', 'b', 'c'].map(invocationId => {
    const quote = { schemaVersion: 1, scopeId: 'scope', requestDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
      pricing: { id: 'price', version: 1, digest: '291f395a66cb728f57612b09b06f9512815b982e9a5d65e3fafec28256ff0aa9', definition: { schemaVersion: 1, kind: 'synthetic-price' } }, meter: { id: 'meter', version: 1, evidenceDigest: '446658cc1c39184b672f423a7f970bffab0e8f38e851c5b5dacd3f38eb85051f', evidence: { schemaVersion: 1, kind: 'synthetic-meter' } },
      currency: 'USD', maxChargeMinorUnits: 3 };
    const next = reserveProviderSpend(account, budget, { schemaVersion: 1, scopeId: 'scope', invocationId,
      budgetId: budget.budgetId, budgetRevision: budget.revision, currency: budget.currency, quoteDigest: providerSpendQuoteDigest(quote), quote });
    account = next.account; return next.reservation;
  });
  return { account, reservations, checkpoint: createProviderSpendCheckpoint(account, 3, 3) };
}

it('checks canonical account digests, safe counters and corruption without claiming authentication', () => {
  const f = fixture();
  expect(parseProviderSpendCheckpoint(f.checkpoint)).toEqual(f.checkpoint);
  expect(() => createProviderSpendCheckpoint(f.account, 2, 3)).toThrow('PROVIDER_SPEND_INVALID');
  for (const change of [{ revision: 4 }, { reservationCount: 2 }, { account: { ...f.account, reservedMinorUnits: 8 } },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { digest: '0'.repeat(64) }]) {
    expect(() => parseProviderSpendCheckpoint({ ...f.checkpoint, ...change })).toThrow('PROVIDER_SPEND_INVALID');
  }
  let read = false;
  const hostile = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { read = true; return 1; } });
  expect(() => parseProviderSpendCheckpoint(hostile)).toThrow('PROVIDER_SPEND_INVALID'); expect(read).toBe(false);
});

it('folds bounded pages and reports only the exact checkpoint that was verified', async () => {
  const f = fixture(); let calls = 0;
  const reader: ProviderSpendIntegrityReader = { async readPage(query) {
    expect(query.limit).toBe(2); expect(query.scopeId).toBe('scope'); calls++;
    if (calls === 1) { expect(query.checkpoint).toBeNull(); expect(query.afterInvocationId).toBeNull(); }
    else { expect(query.checkpoint).toEqual(f.checkpoint); expect(query.afterInvocationId).toBe('b'); }
    return { checkpoint: f.checkpoint, reservations: calls === 1 ? f.reservations.slice(0, 2) : f.reservations.slice(2),
      nextInvocationId: calls === 1 ? 'b' : null };
  }, close() {} };
  expect(await verifyProviderSpendIntegrity(reader, 'scope', 2)).toEqual({ checkpoint: f.checkpoint,
    reservationCount: 3, reservedMinorUnits: 9, settledMinorUnits: 0 }); expect(calls).toBe(2);
});

it.each(['duplicate', 'missing', 'cursor', 'totals', 'freeze', 'scope', 'oversized', 'revision'] as const)(
  'rejects %s pages instead of fabricating an integrity success', async kind => {
    const f = fixture(); let calls = 0;
    const reader: ProviderSpendIntegrityReader = { async readPage() {
      calls++;
      const page: ProviderSpendIntegrityPage = { checkpoint: f.checkpoint, reservations: f.reservations.slice(0, 2), nextInvocationId: 'b' };
      if (kind === 'duplicate') return { ...page, reservations: [f.reservations[0]!, f.reservations[0]!] };
      if (kind === 'missing') return { ...page, reservations: f.reservations.slice(0, 1), nextInvocationId: null };
      if (kind === 'cursor') return { ...page, nextInvocationId: 'a' };
      if (kind === 'totals') return { ...page, checkpoint: createProviderSpendCheckpoint({ ...f.account, reservedMinorUnits: 8 }, 3, 3),
        reservations: f.reservations, nextInvocationId: null };
      if (kind === 'freeze') return { ...page, checkpoint: createProviderSpendCheckpoint({ ...f.account, frozen: true }, 3, 3),
        reservations: f.reservations, nextInvocationId: null };
      if (kind === 'scope') return { ...page, checkpoint: createProviderSpendCheckpoint({ ...f.account,
        budget: { ...f.account.budget, scopeId: 'foreign' } }, 3, 3) };
      if (kind === 'oversized') return { ...page, reservations: f.reservations, nextInvocationId: null };
      if (calls === 1) return page;
      return { checkpoint: createProviderSpendCheckpoint(f.account, 4, 3), reservations: f.reservations.slice(2), nextInvocationId: null };
    }, close() {} };
    await expect(verifyProviderSpendIntegrity(reader, 'scope', kind === 'totals' || kind === 'freeze' ? 3 : 2)).rejects.toThrow(
      kind === 'revision' ? 'PROVIDER_SPEND_CONFLICT' : 'PROVIDER_SPEND_INVALID');
    expect(calls).toBeLessThanOrEqual(2);
  });

it('distinguishes absent accounts, disappearing accounts and cancellation without unbounded iteration', async () => {
  const f = fixture(), controller = new AbortController(); let calls = 0;
  const empty: ProviderSpendIntegrityReader = { async readPage() { calls++; return null; }, close() {} };
  expect(await verifyProviderSpendIntegrity(empty, 'scope', 1)).toBeNull(); expect(calls).toBe(1);
  calls = 0;
  const vanished: ProviderSpendIntegrityReader = { async readPage() { return ++calls === 1
    ? { checkpoint: f.checkpoint, reservations: f.reservations.slice(0, 1), nextInvocationId: 'a' } : null; }, close() {} };
  await expect(verifyProviderSpendIntegrity(vanished, 'scope', 1)).rejects.toThrow('PROVIDER_SPEND_CONFLICT');
  controller.abort();
  await expect(verifyProviderSpendIntegrity(empty, 'scope', 1, controller.signal)).rejects.toThrow('PROVIDER_SPEND_UNAVAILABLE');
  expect(calls).toBe(2);
  for (const limit of [0, -1, 0.5, 1001, Infinity]) {
    await expect(verifyProviderSpendIntegrity(empty, 'scope', limit)).rejects.toThrow('PROVIDER_SPEND_INVALID');
  }
});
