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
/** S6R-5 (lead on s6r4 Q1): the protected `runRuntime.recovery.mode` a Run froze at admission. `shadow` seals what a decision would do and changes
 * nothing; `live` may continue. `off` freezes no recovery section at all. The stricter of the frozen and the current mode applies. */
export const RECOVERY_RUN_MODES = Object.freeze(['shadow', 'live'] as const);
export type RecoveryRunMode = typeof RECOVERY_RUN_MODES[number];
/** The bounds a Run freezes at admission (like `stall`) with its recovery mode. Absent on a Run (admitted before the switch, or with recovery off): no
 * continuation ever. alpha.56 G6 (owner Q-A3): `lowRiskTaskIds`, the tasks whose WorkClass the registry marks `proposalAdmission.risk: low`; only
 * they may continue (absent: a Run admitted before the field, none). */
export const runRecoveryPolicySchema = z.object({ schemaVersion: z.literal(1), registryRevision: identitySchema, mode: z.enum(RECOVERY_RUN_MODES), ...bounds,
  lowRiskTaskIds: z.array(identitySchema).max(1024).readonly().optional() }).strict().readonly();
export type RunRecoveryPolicy = z.infer<typeof runRecoveryPolicySchema>;
export const RECOVERY_POLICY_SEED: unknown = Object.freeze(seed);
export function loadRecoveryPolicy(input: unknown): RecoveryPolicyRegistry { return recoveryPolicyRegistrySchema.parse(input); }
export function freezeRecoveryPolicy(registry: RecoveryPolicyRegistry, mode: RecoveryRunMode, lowRiskTaskIds?: readonly string[]): RunRecoveryPolicy {
  const value = recoveryPolicyRegistrySchema.parse(registry);
  return runRecoveryPolicySchema.parse({ schemaVersion: 1, registryRevision: value.revision, mode, maxLostContinuationsPerTask: value.maxLostContinuationsPerTask,
    maxRecoveryActionsPerRun: value.maxRecoveryActionsPerRun, maxAttemptsPerTask: value.maxAttemptsPerTask, maxGateIntents: value.maxGateIntents, settledFacts: value.settledFacts,
    ...(lowRiskTaskIds ? { lowRiskTaskIds: [...new Set(lowRiskTaskIds)] } : {}) });
}
