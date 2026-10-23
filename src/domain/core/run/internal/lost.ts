import { sameAttemptIdentity, type AttemptIdentity } from '#domain/core/attempt/index.js';
import { counterSchema } from '#domain/core/primitives/index.js';
import { RecoveryError, recoveryEffectGateSchema, recoveryGateRefusal, type RecoveryErrorCode } from '#domain/core/recovery/index.js';
import { checkedRun, type RunSnapshot } from './contract.js';
import { reconcileRunLifecycle } from './lifecycle.js';

/** What a continuation carries: the sealed decision id, the case's evidence signature, the gate the writer re-derived in its own transaction and the
 * signatures of the task's earlier continued cases (changed-evidence requirement, S6R-DESIGN §8). */
export type LostContinuation = Readonly<{ decisionId: string; signature: string | null; gate: unknown; priorSignatures: readonly string[] }>;

/**
 * Pure: why the lost task of `identity` may not continue now (null: it may), in a fixed order — the Run is closing, it was admitted without frozen
 * recovery bounds (before the switch: never), the case is not ready (the Attempt is the task's current `unknown` binding, the task `reconciling`
 * with its slot released by a termination proof), the gate (nothing open; settled work only where the catalog declares task-scoped idempotency),
 * then the frozen bounds — continuations per task, the total Attempt ceiling per task across every automatic path (stall, lost; stricter wins),
 * continuations per Run — and, when a signature is given, the changed-evidence requirement.
 */
export function lostContinuationRefusal(run: RunSnapshot, identity: AttemptIdentity, continuation: Omit<LostContinuation, 'decisionId'>): RecoveryErrorCode | null {
  if (run.cancelRequested || run.state.kind === 'terminal') return 'RECOVERY_RUN_CLOSED';
  const policy = run.execution.recovery;
  if (!policy) return 'RECOVERY_OFF';
  const task = run.progress.find(row => row.taskId === identity.taskId), binding = run.bindings.find(row => sameAttemptIdentity(row.identity, identity));
  if (!task || !binding || binding.observedKind !== 'unknown' || task.phase !== 'reconciling' || !task.unresolvedEffects || task.workerCustody?.state !== 'released'
    || task.workerCustody.basis !== 'termination-proof') return 'RECOVERY_NOT_READY';
  const gate = recoveryEffectGateSchema.safeParse(continuation.gate);
  if (!gate.success) return 'RECOVERY_INVALID';
  const refused = recoveryGateRefusal(gate.data);
  if (refused) return refused;
  const previous = (run.previousBindings ?? []).filter(row => row.identity.taskId === identity.taskId);
  if (previous.filter(row => row.observedKind === 'lost').length >= policy.maxLostContinuationsPerTask) return 'RECOVERY_CONTINUATION_BOUND';
  // Superseded Attempts + the lost one + the new one.
  if (previous.length + 2 > policy.maxAttemptsPerTask) return 'RECOVERY_ATTEMPT_CEILING';
  if ((run.previousBindings ?? []).filter(row => row.observedKind === 'lost').length >= policy.maxRecoveryActionsPerRun) return 'RECOVERY_RUN_BOUND';
  if (continuation.signature !== null && continuation.priorSignatures.includes(continuation.signature)) return 'RECOVERY_SAME_EVIDENCE';
  return null;
}
/**
 * S6R-4 (S6R-DESIGN §7 step 6; owner Q-R1/Q-R3/Q-R5, the A5/K-B exception for a lost worker): the one transition that returns a lost task to
 * `pending` for a NEW Attempt, beside `recoverStalledTask` (same owner, same `previousBindings` pattern). The lost binding becomes `lost` with its
 * recovery decision; the task drops the released custody (the next Attempt holds a slot again), clears `unresolvedEffects` only because the gate
 * passed, and waits for the next generation and a new lease from the base (the lost workspace is never applied). Anything else is a typed refusal.
 */
export function continueLostTask(input: unknown, expectedRevision: number, identity: AttemptIdentity, continuation: LostContinuation,
  timing: Readonly<{ now: number; timeoutMs: number }>) {
  const run = checkedRun(input, expectedRevision);
  const refused = lostContinuationRefusal(run, identity, continuation);
  if (refused) throw new RecoveryError(refused);
  const binding = run.bindings.find(row => sameAttemptIdentity(row.identity, identity))!, task = run.progress.find(row => row.taskId === identity.taskId)!;
  const next = { ...task, phase: 'pending' as const, unresolvedEffects: false, workerCustody: undefined, decision: undefined, notAcceptedReason: undefined,
    eligibility: { kind: 'immediate' as const } };
  const snapshot = reconcileRunLifecycle({ ...run, revision: run.revision + 1, progress: run.progress.map(row => row === task ? next : row),
    bindings: run.bindings.filter(row => row !== binding),
    previousBindings: [...run.previousBindings ?? [], { ...binding, observedKind: 'lost', recoveryDecisionId: continuation.decisionId }] }, counterSchema.parse(timing.now), timing.timeoutMs);
  return Object.freeze({ snapshot });
}
