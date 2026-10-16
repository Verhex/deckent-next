import { z } from 'zod';
import defaults from './target-queue-defaults.json' with { type: 'json' };
const count = () => z.number().int().positive().safe();
const duration = () => count().max(2_147_483_647);
/** Mutable installation policy, independent of adapter, surface and worker counts. */
export const TARGET_QUEUE_SETTINGS = z.object({ schemaVersion: z.literal(1).default(1),
  capacity: count().default(defaults.capacity), perTarget: count().default(defaults.perTarget), activeTargets: count().default(defaults.activeTargets),
  batchSize: count().default(defaults.batchSize), chainSize: count().default(defaults.chainSize),
  batchWindowMs: duration().default(defaults.batchWindowMs), leaseMs: duration().default(defaults.leaseMs), ttlMs: duration().default(defaults.ttlMs),
  verificationTimeoutMs: duration().default(defaults.verificationTimeoutMs), revalidations: z.number().int().nonnegative().safe().default(defaults.revalidations),
  candidateSlots: count().default(defaults.candidateSlots) }).strict().superRefine((value, context) => {
    if (value.chainSize > value.batchSize || value.batchSize > value.perTarget || value.perTarget > value.capacity || value.activeTargets > value.capacity)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'QUEUE_CAPACITY' });
  });
