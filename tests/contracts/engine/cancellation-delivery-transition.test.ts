import { expect, it } from 'vitest';
import { decideCancellationDeliveryClaim, decideCancellationDeliveryFinish } from '#engine/index.js';
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
const input = { identity, token: 'first', now: 10, limits: { maxAttempts: 2, retryDelayMs: 5, claimTtlMs: 20 } };
it('persists bounded eligibility and prevents concurrent or stale delivery ownership', () => {
  const first = decideCancellationDeliveryClaim(input, null); expect(first.acquired).toBe(true);
  expect(decideCancellationDeliveryClaim({ ...input, token: 'second', now: 29 }, first.record).acquired).toBe(false);
  const secondInput = { ...input, token: 'second', now: 30 };
  const second = decideCancellationDeliveryClaim(secondInput, first.record); expect(second.record.attempts).toBe(2);
  expect(() => decideCancellationDeliveryFinish({ ...input, now: 31, outcome: 'terminal' }, second.record)).toThrow('CANCELLATION_DELIVERY_CONFLICT');
  const exhausted = decideCancellationDeliveryFinish({ ...secondInput, now: 32, outcome: 'unresolved' }, second.record);
  expect(exhausted.state).toBe('exhausted'); expect(decideCancellationDeliveryClaim({ ...input, now: 100 }, exhausted).acquired).toBe(false);
});
it('records backoff for nonterminal outcomes without pretending cancellation succeeded', () => {
  for (const outcome of ['denied', 'unavailable', 'unresolved'] as const) {
    const first = decideCancellationDeliveryClaim(input, null);
    const next = decideCancellationDeliveryFinish({ ...input, now: 12, outcome }, first.record);
    expect(next).toMatchObject({ state: 'queued', lastOutcome: outcome, nextEligibleAt: 17 });
    expect(decideCancellationDeliveryClaim({ ...input, token: 'next', now: 16 }, next).acquired).toBe(false);
    expect(decideCancellationDeliveryClaim({ ...input, token: 'next', now: 17 }, next).acquired).toBe(true);
  }
});
it('does not requeue settled deliveries or permit foreign identity and unsafe time arithmetic', () => {
  const first = decideCancellationDeliveryClaim(input, null);
  for (const outcome of ['terminal', 'prevented'] as const) {
    const final = decideCancellationDeliveryFinish({ ...input, outcome }, first.record);
    expect(decideCancellationDeliveryClaim({ ...input, token: 'next', now: 999 }, final).acquired).toBe(false);
  }
  expect(() => decideCancellationDeliveryClaim({ ...input, identity: { ...identity, scopeId: 'other' } }, first.record)).toThrow('CANCELLATION_DELIVERY_CONFLICT');
  expect(() => decideCancellationDeliveryClaim({ ...input, now: Number.MAX_SAFE_INTEGER }, null)).toThrow();
});
