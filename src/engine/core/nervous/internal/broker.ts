import { z } from 'zod';
import { RECOVERY_ACTIONS, RECOVERY_ROLLOUT, counterSchema, evaluatePolicy, identitySchema, isAiPrincipal, policyResources, recoveryActionSchema, type AuditEvent, type VerifiedPrincipal } from '#domain/index.js';
import type { NervousProposal } from './detect.js';

/**
 * The owner's K-B standing approval record (S6R-3: derived from the owner's policy grant, `nervousStandingApproval`): which standing-list actions
 * the broker may apply, in which scopes, under which owner decision. An AI-authored, foreign-scope or unreadable record is no approval.
 */
export const nervousStandingApprovalSchema = z.object({ schemaVersion: z.literal(1), decisionRef: identitySchema,
  approvedBy: z.object({ issuer: identitySchema, subject: identitySchema, assurance: z.enum(['os-user', 'token-verified', 'workload-verified']) }).strict(),
  approvedAtMs: counterSchema, scopeIds: z.array(identitySchema).min(1).max(1024), actions: z.array(recoveryActionSchema).min(1).max(RECOVERY_ACTIONS.length) }).strict().readonly();
export type NervousStandingApproval = z.infer<typeof nervousStandingApprovalSchema>;
/** One executor per standing-list action, each an existing application (S6R-3 wires them); a proposal never reaches the raw adapter. */
export type NervousExecutors = Readonly<Partial<Record<(typeof RECOVERY_ACTIONS)[number], (proposal: NervousProposal, options?: Readonly<{ last: boolean }>) => Promise<unknown>>>>;
export type NervousDisposition = Extract<AuditEvent['subject'], { kind: 'recovery-detection' }>['disposition'];

/**
 * S6R-3 (lead on s6 Q3): the standing approval is the owner's policy grant — `apply` on `recovery-action/<action>` for the installation's own
 * principal in the proposal's scope. Policy administration is a person's (AI floor), and the floor refuses this grant to every AI principal.
 * Read fresh per proposal from the loaded policy; no grant, any doubt or an unreadable policy is no approval.
 */
export function nervousStandingApproval(document: unknown, principal: VerifiedPrincipal, proposal: Pick<NervousProposal, 'scopeId' | 'action'>, nowMs: number): NervousStandingApproval | null {
  const { kind, actions: [apply] } = policyResources.recoveryAction;
  try {
    const decision = evaluatePolicy(document, { principal, scopeId: proposal.scopeId, action: apply, resource: { kind, id: proposal.action } });
    if (decision.decision !== 'allow' || !decision.ruleId) return null;
    const record = nervousStandingApprovalSchema.safeParse({ schemaVersion: 1, decisionRef: decision.ruleId, approvedBy: { issuer: principal.issuer, subject: principal.subject,
      assurance: principal.assurance }, approvedAtMs: nowMs, scopeIds: [proposal.scopeId], actions: [proposal.action] });
    return record.success ? record.data : null;
  } catch { return null; }
}
/**
 * alpha.56 G2 (owner Q-A1/Q-A4): whether a person promoted exactly `ruleId@version` in `scopeId` — `promote` on `nervous-rule/<ruleId>@<version>`
 * for the installation's own principal, read fresh per page from the loaded policy; only the rollout's measured rules. Any doubt is no promotion.
 */
export function nervousRulePromoted(document: unknown, principal: VerifiedPrincipal, scopeId: string, ruleId: string, version: number): boolean {
  const { kind, actions: [promote] } = policyResources.nervousRule;
  try {
    return !isAiPrincipal(principal) && RECOVERY_ROLLOUT.rules.includes(ruleId)
      && evaluatePolicy(document, { principal, scopeId, action: promote, resource: { kind, id: `${ruleId}@${version}` } }).decision === 'allow';
  } catch { return false; }
}
/** Which target each executable action needs: the stop chain one Attempt, a hold one Run (an Attempt's or a task's); a scope case has neither. */
const TARGETS: Readonly<Partial<Record<NervousProposal['action'], readonly NervousProposal['target']['kind'][]>>> = Object.freeze({
  'fence-attempt': ['attempt'], 'stop-orphan': ['attempt'], 'hold-run': ['attempt', 'task'], 'hand-to-human': ['attempt', 'task'] });
/**
 * The broker's decision for one valid proposal: execute only when live, for a measured rule, under the owner's standing approval of this action in
 * this scope, with an executor for its target kind. `live` false (config `shadow`): proposals are sealed and nothing executes.
 */
export function nervousDisposition(proposal: NervousProposal, live: boolean, approval: unknown, executors: NervousExecutors): NervousDisposition {
  if (!live) return 'shadow-only';
  const record = nervousStandingApprovalSchema.safeParse(approval);
  if (!record.success || isAiPrincipal(record.data.approvedBy) || !record.data.scopeIds.includes(proposal.scopeId) || !record.data.actions.includes(proposal.action)) return 'proposal-only';
  if (proposal.rule.status !== 'live' || !Object.hasOwn(executors, proposal.action) || !TARGETS[proposal.action]?.includes(proposal.target.kind)) return 'proposal-only';
  return 'execute';
}
