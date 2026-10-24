import { z } from 'zod';
import { counterSchema, evaluatePolicy, identitySchema, isAiPrincipal, policyResources, type VerifiedPrincipal } from '#domain/index.js';

/** The standing-list id of a continuation (not a Nervous stop action: Nervous never chooses continuation, S6R-DESIGN §3). */
export const RECOVERY_CONTINUE_ACTION = 'continue-new-attempt';
/** The owner's standing approval of automatic continuations in one scope (S6R-DESIGN §7 step 6, §9; owner Q-R5 d). A person's grant, never an AI's. */
export const recoveryContinuationApprovalSchema = z.object({ schemaVersion: z.literal(1), decisionRef: identitySchema,
  approvedBy: z.object({ issuer: identitySchema, subject: identitySchema, assurance: z.enum(['os-user', 'token-verified', 'workload-verified']) }).strict(),
  approvedAtMs: counterSchema, scopeIds: z.array(identitySchema).min(1).max(1024), action: z.literal(RECOVERY_CONTINUE_ACTION) }).strict().readonly();
export type RecoveryContinuationApproval = z.infer<typeof recoveryContinuationApprovalSchema>;
/**
 * The owner's policy grant `apply` on `recovery-action/continue-new-attempt` for the installation's own principal in `scopeId`, read fresh per call
 * (a revoked grant stops the next continuation). The AI floor refuses this grant to every AI principal; no grant, any doubt or an unreadable policy is no approval.
 */
export function recoveryContinuationApproval(document: unknown, principal: VerifiedPrincipal, scopeId: string, nowMs: number): RecoveryContinuationApproval | null {
  const { kind, actions: [apply] } = policyResources.recoveryAction;
  try {
    if (isAiPrincipal(principal)) return null;
    const decision = evaluatePolicy(document, { principal, scopeId, action: apply, resource: { kind, id: RECOVERY_CONTINUE_ACTION } });
    if (decision.decision !== 'allow' || !decision.ruleId) return null;
    const record = recoveryContinuationApprovalSchema.safeParse({ schemaVersion: 1, decisionRef: decision.ruleId, approvedBy: { issuer: principal.issuer, subject: principal.subject,
      assurance: principal.assurance }, approvedAtMs: nowMs, scopeIds: [scopeId], action: RECOVERY_CONTINUE_ACTION });
    return record.success ? record.data : null;
  } catch { return null; }
}
