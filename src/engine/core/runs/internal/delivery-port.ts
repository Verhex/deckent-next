import { z } from 'zod';
import { attemptIdentitySchema, counterSchema, identitySchema } from '#domain/index.js';

export const cancellationDeliveryLimitsSchema = z.object({
  maxAttempts: counterSchema.positive(), retryDelayMs: counterSchema.positive(), claimTtlMs: counterSchema.positive(),
}).strict().readonly();
export const cancellationDeliveryOutcomeSchema = z.enum(['terminal', 'prevented', 'unresolved', 'unavailable', 'denied']);
export const cancellationDeliverySchema = z.object({
  schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  state: z.enum(['claimed', 'queued', 'terminal', 'prevented', 'exhausted']),
  attempts: counterSchema.positive(), token: identitySchema, claimUntil: counterSchema,
  nextEligibleAt: counterSchema, lastOutcome: cancellationDeliveryOutcomeSchema.nullable(),
}).strict().readonly();
export type CancellationDelivery = z.infer<typeof cancellationDeliverySchema>;
export type CancellationDeliveryLimits = z.infer<typeof cancellationDeliveryLimitsSchema>;
export type CancellationDeliveryOutcome = z.infer<typeof cancellationDeliveryOutcomeSchema>;
export interface CancellationDeliveryClaim {
  readonly identity: CancellationDelivery['identity']; readonly token: string; readonly now: number;
  readonly limits: CancellationDeliveryLimits;
}
export type CancellationDeliveryClaimResult = Readonly<{ acquired: boolean; record: CancellationDelivery }>;
export interface CancellationDeliveryStore {
  /** Atomic eligibility/attempt accounting. Requires existing durable cancellation intent and exact identity. */
  claimCancellationDelivery(input: CancellationDeliveryClaim): Promise<CancellationDeliveryClaimResult>;
  /** Token CAS: a superseded delivery can never overwrite a newer outcome. */
  finishCancellationDelivery(input: CancellationDeliveryClaim & { readonly outcome: CancellationDeliveryOutcome }): Promise<CancellationDelivery>;
}
export class CancellationDeliveryError extends Error {
  constructor(readonly code: 'CANCELLATION_DELIVERY_CONFLICT' | 'CANCELLATION_DELIVERY_CORRUPT') { super(code); this.name = 'CancellationDeliveryError'; }
}
