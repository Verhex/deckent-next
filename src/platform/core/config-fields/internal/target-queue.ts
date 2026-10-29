import { z } from 'zod';
import defaults from './target-queue-defaults.json' with { type: 'json' };
const count = () => z.number().int().positive().safe();
const duration = () => count().max(2_147_483_647);
/** Mutable installation policy, independent of adapter, surface and worker counts. */
export const TARGET_QUEUE_SETTINGS = z.object({ schemaVersion: z.literal(1).default(1),
  capacity: count().default(defaults.capacity).describe('config.field.targetQueue.capacity'), perTarget: count().default(defaults.perTarget).describe('config.field.targetQueue.perTarget'), activeTargets: count().default(defaults.activeTargets).describe('config.field.targetQueue.activeTargets'),
  batchSize: count().default(defaults.batchSize).describe('config.field.targetQueue.batchSize'), chainSize: count().default(defaults.chainSize).describe('config.field.targetQueue.chainSize'),
  batchWindowMs: duration().default(defaults.batchWindowMs).describe('config.field.targetQueue.batchWindowMs'), leaseMs: duration().default(defaults.leaseMs).describe('config.field.targetQueue.leaseMs'), ttlMs: duration().default(defaults.ttlMs).describe('config.field.targetQueue.ttlMs'),
  verificationTimeoutMs: duration().default(defaults.verificationTimeoutMs).describe('config.field.targetQueue.verificationTimeoutMs'), revalidations: z.number().int().nonnegative().safe().default(defaults.revalidations).describe('config.field.targetQueue.revalidations'),
  candidateSlots: count().default(defaults.candidateSlots).describe('config.field.targetQueue.candidateSlots'),
  // D1a (owner 2026-10-18): automatic re-attempts per delivery-intent lineage after the target base advanced (0 disables), and how long after
  // the human's enqueue the service still starts or enqueues one.
  reattempts: z.number().int().nonnegative().safe().default(defaults.reattempts).describe('config.field.targetQueue.reattempts'), reattemptWindowMs: duration().default(defaults.reattemptWindowMs).describe('config.field.targetQueue.reattemptWindowMs'),
  // D2b (owner 2026-10-18): service re-queues per delegated Attempt under a Run's delivery intent after a pre-effect stop (0 disables).
  requeueMax: z.number().int().nonnegative().safe().default(defaults.requeueMax).describe('config.field.targetQueue.requeueMax') }).strict().superRefine((value, context) => {
    if (value.chainSize > value.batchSize || value.batchSize > value.perTarget || value.perTarget > value.capacity || value.activeTargets > value.capacity)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'QUEUE_CAPACITY' });
  });
