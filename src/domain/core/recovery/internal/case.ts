import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
import { DISPATCH_PREPARATION_PHASES, NERVOUS_ACTIVITY_STATES } from '#domain/core/audit/index.js';
import { RecoveryError, recoveryEffectGateSchema, type RecoveryErrorCode } from './gate.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** S6R-DESIGN §12: a recovery case moves only forward — `open` (reserved for S6R-5's model call in flight), `gated` (gate computed), `decided`
 * (reserved: S6R-5's sealed model decision before its apply), then one final state, `applied` or `escalated`. */
export const RECOVERY_CASE_STATES = Object.freeze(['open', 'gated', 'decided', 'applied', 'escalated'] as const);
/** S6R-DESIGN §6 output enum (shared with S6R-5's chooser). */
export const RECOVERY_CAUSE_CLASSES = Object.freeze(['infra-transient', 'infra-persistent', 'task-induced', 'unknown'] as const);
/** Why a case went to a person: a gate or bound refusal, the Run closing, or the decision itself (`human-chosen`). S6R-5 adds the decision path's own:
 * no owner standing grant for a continuation, no eligible role model, no delegated-use consent for a subscription (Q-H3), the call failed, the answer
 * was invalid, the circuit breaker is open. Stable codes, no prose. */
export const RECOVERY_ESCALATION_CODES = Object.freeze(['effects-open', 'settled-not-idempotent', 'settled-over-bound', 'continuation-bound', 'attempt-ceiling', 'run-bound',
  'same-evidence', 'run-closed', 'human-chosen', 'continuation-not-approved', 'no-eligible-model', 'consent-required', 'model-failed', 'answer-invalid', 'breaker-open',
  // alpha.56 G6 (owner Q-R2/Q-A3): the task's WorkClass is not low-risk (registry `proposalAdmission.risk`, frozen at admission).
  'work-class-not-low-risk',
  // alpha.56 D2: the lost Attempt's dispatch record does not prove its worker had no route to a customer system (no block, unreadable or wider).
  'isolation-unproven'] as const);
/** A note code: the only thing of a decision that may reach the next Attempt, as its registry text (v1 never forwards free model text). */
export const recoveryNoteCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
export type RecoveryEscalationCode = typeof RECOVERY_ESCALATION_CODES[number];
const ESCALATIONS: Readonly<Partial<Record<RecoveryErrorCode, RecoveryEscalationCode>>> = Object.freeze({ RECOVERY_EFFECTS_OPEN: 'effects-open',
  RECOVERY_SETTLED_NOT_IDEMPOTENT: 'settled-not-idempotent', RECOVERY_SETTLED_OVER_BOUND: 'settled-over-bound', RECOVERY_CONTINUATION_BOUND: 'continuation-bound',
  RECOVERY_ATTEMPT_CEILING: 'attempt-ceiling', RECOVERY_RUN_BOUND: 'run-bound', RECOVERY_SAME_EVIDENCE: 'same-evidence', RECOVERY_RUN_CLOSED: 'run-closed',
  RECOVERY_NOT_APPROVED: 'continuation-not-approved', RECOVERY_RISK_NOT_LOW: 'work-class-not-low-risk',
  RECOVERY_ISOLATION_UNPROVEN: 'isolation-unproven' });
/** The escalation a typed refusal means (null: a caller error, which writes nothing). */
export function recoveryEscalationCode(error: unknown): RecoveryEscalationCode | null { return error instanceof RecoveryError ? ESCALATIONS[error.code] ?? null : null; }

export const recoveryDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('continue-new-attempt'), decisionId: digest, causeClass: z.enum(RECOVERY_CAUSE_CLASSES), signature: digest, standingRef: identitySchema,
    /** S6R-5: the registry note code the decision passes to the next Attempt (absent: none). */
    note: recoveryNoteCodeSchema.optional() }).strict(),
  z.object({ action: z.literal('escalate-human'), code: z.enum(RECOVERY_ESCALATION_CODES) }).strict(),
]).readonly();
export type RecoveryDecision = z.infer<typeof recoveryDecisionSchema>;
/**
 * One sealed recovery case of one lost Attempt (case id = the Nervous detection's case id: Attempt identity and rule). It holds what the gate saw
 * and the termination proof the release used, digested into `evidenceDigest`, which a decision must echo; a different digest is a stale case.
 * alpha.56 G1: `basis: 'would-stop'` is the shadow input of a detection whose stop step did not run — its termination is the hypothetical one a
 * live stop would yield (no receipt). Such a case is only decided in shadow and never stored, held or applied.
 */
export const recoveryCaseSchema = z.object({ schemaVersion: z.literal(1), caseId: digest, revision: counterSchema.positive(), state: z.enum(RECOVERY_CASE_STATES),
  identity: attemptIdentitySchema,
  detection: z.object({ eventId: identitySchema, ruleId: identitySchema, ruleVersion: counterSchema.positive(), registryRevision: identitySchema, evidenceDigest: digest,
    activity: z.enum(NERVOUS_ACTIVITY_STATES).nullable(), launcherPhase: z.enum(DISPATCH_PREPARATION_PHASES).nullable() }).strict().readonly(),
  basis: z.literal('would-stop').optional(),
  termination: z.object({ receiptId: identitySchema.nullable(), kind: z.enum(['worker-absent', 'supervisor-exit', 'created-container-absent']), exitCode: z.number().int().safe().nullable() }).strict().readonly(),
  gate: recoveryEffectGateSchema, evidenceDigest: digest, decision: recoveryDecisionSchema.optional(), openedAtMs: counterSchema, updatedAtMs: counterSchema,
}).strict().superRefine((value, context) => {
  const kind = value.decision?.action;
  if ((value.state === 'applied') !== (kind === 'continue-new-attempt') || (value.state === 'escalated') !== (kind === 'escalate-human') || value.updatedAtMs < value.openedAtMs
    || (value.termination.receiptId === null) !== (value.basis === 'would-stop'))
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'RECOVERY_CASE_INCONSISTENT' });
}).readonly();
export type RecoveryCase = z.infer<typeof recoveryCaseSchema>;
export const isFinalRecoveryCase = (value: Pick<RecoveryCase, 'state'>) => value.state === 'applied' || value.state === 'escalated';
/** Pure: the one forward step that closes a case with its decision (a final case never changes). */
export function closeRecoveryCase(input: unknown, decisionInput: unknown, nowMs: number): RecoveryCase {
  const current = recoveryCaseSchema.parse(input), decision = recoveryDecisionSchema.parse(decisionInput);
  if (isFinalRecoveryCase(current)) throw new RecoveryError('RECOVERY_CONFLICT');
  return recoveryCaseSchema.parse({ ...current, revision: current.revision + 1, state: decision.action === 'continue-new-attempt' ? 'applied' : 'escalated', decision,
    updatedAtMs: Math.max(current.updatedAtMs, counterSchema.parse(nowMs)) });
}
