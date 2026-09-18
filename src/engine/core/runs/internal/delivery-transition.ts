import { sameAttemptIdentity, counterSchema, identitySchema, attemptIdentitySchema } from '#domain/index.js';
import { cancellationDeliverySchema, cancellationDeliveryLimitsSchema, cancellationDeliveryOutcomeSchema,
  CancellationDeliveryError, type CancellationDelivery, type CancellationDeliveryClaim, type CancellationDeliveryOutcome } from './delivery-port.js';

function validate(input: CancellationDeliveryClaim) {
  return { identity: attemptIdentitySchema.parse(input.identity), token: identitySchema.parse(input.token),
    now: counterSchema.parse(input.now), limits: cancellationDeliveryLimitsSchema.parse(input.limits) };
}
/** Delivery leases permit retrying cancellation only; they never confer launch permission. */
export function decideCancellationDeliveryClaim(input: CancellationDeliveryClaim, previous: CancellationDelivery | null) {
  const { identity, token, now, limits } = validate(input);
  const prior = previous === null ? null : cancellationDeliverySchema.parse(previous);
  if (prior && !sameAttemptIdentity(prior.identity, identity)) throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CONFLICT');
  if (prior && (['terminal', 'prevented', 'exhausted'].includes(prior.state)
    || (prior.state === 'claimed' && prior.claimUntil > now) || prior.nextEligibleAt > now)) return Object.freeze({ acquired: false, record: prior });
  if (prior && prior.attempts >= limits.maxAttempts) {
    return Object.freeze({ acquired: false, record: cancellationDeliverySchema.parse({ ...prior, state: 'exhausted' }) });
  }
  if (prior?.token === token) throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CONFLICT');
  return Object.freeze({ acquired: true, record: cancellationDeliverySchema.parse({ schemaVersion: 1, identity,
    state: 'claimed', attempts: (prior?.attempts ?? 0) + 1, token, claimUntil: now + limits.claimTtlMs,
    nextEligibleAt: now, lastOutcome: prior?.lastOutcome ?? null }) });
}
export function decideCancellationDeliveryFinish(input: CancellationDeliveryClaim & { readonly outcome: CancellationDeliveryOutcome }, previous: CancellationDelivery) {
  const { identity, token, now, limits } = validate(input); const outcome = cancellationDeliveryOutcomeSchema.parse(input.outcome);
  const prior = cancellationDeliverySchema.parse(previous);
  if (!sameAttemptIdentity(prior.identity, identity) || prior.token !== token || prior.state !== 'claimed') throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CONFLICT');
  const state = outcome === 'terminal' || outcome === 'prevented' ? outcome : prior.attempts >= limits.maxAttempts ? 'exhausted' : 'queued';
  return cancellationDeliverySchema.parse({ ...prior, state, lastOutcome: outcome, nextEligibleAt: now + limits.retryDelayMs });
}
