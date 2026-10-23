import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import seed from './policy.json' with { type: 'json' };

/**
 * S6R-4 (S6R-DESIGN §8; owner Q-R3 2026-10-23): the recovery bounds, registry data. `maxLostContinuationsPerTask` (seed 1) automatic continuations
 * of a lost task; `maxAttemptsPerTask` (seed 3: the first Attempt and at most 2 automatic ones) across every automatic path — stall (R3), lost and a
 * future RETRY; `maxRecoveryActionsPerRun` (seed 4, provisional until measured) continuations per Run; `maxGateIntents` effect intents one gate
 * may weigh (more reads as open, fail-closed); `settledFacts` the count and bytes of settled task-idempotent work a new Attempt may receive.
 */
const bounds = { maxLostContinuationsPerTask: counterSchema, maxRecoveryActionsPerRun: counterSchema, maxAttemptsPerTask: counterSchema.positive(),
  maxGateIntents: counterSchema.positive(), settledFacts: z.object({ maxCount: counterSchema, maxBytes: counterSchema.positive() }).strict() };
export const recoveryPolicyRegistrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, status: z.enum(['provisional', 'measured']), ...bounds }).strict().readonly();
export type RecoveryPolicyRegistry = z.infer<typeof recoveryPolicyRegistrySchema>;
/** The bounds a Run freezes at admission (like `stall`). Absent on a Run (admitted before the switch, or with recovery off): no continuation ever. */
export const runRecoveryPolicySchema = z.object({ schemaVersion: z.literal(1), registryRevision: identitySchema, ...bounds }).strict().readonly();
export type RunRecoveryPolicy = z.infer<typeof runRecoveryPolicySchema>;
export const RECOVERY_POLICY_SEED: unknown = Object.freeze(seed);
export function loadRecoveryPolicy(input: unknown): RecoveryPolicyRegistry { return recoveryPolicyRegistrySchema.parse(input); }
export function freezeRecoveryPolicy(registry: RecoveryPolicyRegistry): RunRecoveryPolicy {
  const value = recoveryPolicyRegistrySchema.parse(registry);
  return runRecoveryPolicySchema.parse({ schemaVersion: 1, registryRevision: value.revision, maxLostContinuationsPerTask: value.maxLostContinuationsPerTask,
    maxRecoveryActionsPerRun: value.maxRecoveryActionsPerRun, maxAttemptsPerTask: value.maxAttemptsPerTask, maxGateIntents: value.maxGateIntents, settledFacts: value.settledFacts });
}
