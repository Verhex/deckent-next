import { persistedInteger } from '#platform/core/validate/index.js';
import { z } from 'zod';
import defaults from './target-queue-defaults.json' with { type: 'json' };
const count = () => persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const duration = () => count().max(2_147_483_647);
/** Mutable installation policy, independent of adapter, surface and worker counts. */
export const TARGET_QUEUE_SETTINGS = z.strictObject({ schemaVersion: z.literal(1).prefault(1),
  capacity: count().prefault(defaults.capacity).describe('config.field.targetQueue.capacity'), perTarget: count().prefault(defaults.perTarget).describe('config.field.targetQueue.perTarget'), activeTargets: count().prefault(defaults.activeTargets).describe('config.field.targetQueue.activeTargets'),
  batchSize: count().prefault(defaults.batchSize).describe('config.field.targetQueue.batchSize'), chainSize: count().prefault(defaults.chainSize).describe('config.field.targetQueue.chainSize'),
  batchWindowMs: duration().prefault(defaults.batchWindowMs).describe('config.field.targetQueue.batchWindowMs'), leaseMs: duration().prefault(defaults.leaseMs).describe('config.field.targetQueue.leaseMs'), ttlMs: duration().prefault(defaults.ttlMs).describe('config.field.targetQueue.ttlMs'),
  verificationTimeoutMs: duration().prefault(defaults.verificationTimeoutMs).describe('config.field.targetQueue.verificationTimeoutMs'), revalidations: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(defaults.revalidations).describe('config.field.targetQueue.revalidations'),
  candidateSlots: count().prefault(defaults.candidateSlots).describe('config.field.targetQueue.candidateSlots'),
  // D1a (owner 2026-10-18): automatic re-attempts per delivery-intent lineage after the target base advanced (0 disables), and how long after
  // the human's enqueue the service still starts or enqueues one.
  reattempts: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(defaults.reattempts).describe('config.field.targetQueue.reattempts'), reattemptWindowMs: duration().prefault(defaults.reattemptWindowMs).describe('config.field.targetQueue.reattemptWindowMs'),
  // D2b (owner 2026-10-18): service re-queues per delegated Attempt under a Run's delivery intent after a pre-effect stop (0 disables).
  requeueMax: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(defaults.requeueMax).describe('config.field.targetQueue.requeueMax') }).superRefine((value, context) => {
    if (value.chainSize > value.batchSize || value.batchSize > value.perTarget || value.perTarget > value.capacity || value.activeTargets > value.capacity)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'QUEUE_CAPACITY' });
  });
