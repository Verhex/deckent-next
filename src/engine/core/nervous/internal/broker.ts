import { z } from 'zod';
import { RECOVERY_ACTIONS, counterSchema, identitySchema, isAiPrincipal, recoveryActionSchema, type AuditEvent } from '#domain/index.js';
import type { NervousProposal } from './detect.js';

/**
 * The owner's K-B standing approval record (owner-owned; its store and writer are S6R-3): which standing-list actions the broker may apply,
 * in which scopes, under which owner decision. An AI-authored, foreign-scope or unreadable record is no approval.
 */
export const nervousStandingApprovalSchema = z.object({ schemaVersion: z.literal(1), decisionRef: identitySchema,
  approvedBy: z.object({ issuer: identitySchema, subject: identitySchema, assurance: z.enum(['os-user', 'token-verified', 'workload-verified']) }).strict(),
  approvedAtMs: counterSchema, scopeIds: z.array(identitySchema).min(1).max(1024), actions: z.array(recoveryActionSchema).min(1).max(RECOVERY_ACTIONS.length) }).strict().readonly();
export type NervousStandingApproval = z.infer<typeof nervousStandingApprovalSchema>;
/** One executor per standing-list action, each an existing application (S6R-3 wires them); a proposal never reaches the raw adapter. */
export type NervousExecutors = Readonly<Partial<Record<(typeof RECOVERY_ACTIONS)[number], (proposal: NervousProposal) => Promise<unknown>>>>;
export type NervousDisposition = Extract<AuditEvent['subject'], { kind: 'recovery-detection' }>['disposition'];

/**
 * The broker's decision for one valid proposal: execute only when live, for a measured rule, under the owner's standing approval of this action in
 * this scope, with an executor. `live` false (config `shadow`): proposals are sealed and nothing executes; config cannot select live before S6R-3.
 */
export function nervousDisposition(proposal: NervousProposal, live: boolean, approval: unknown, executors: NervousExecutors): NervousDisposition {
  if (!live) return 'shadow-only';
  const record = nervousStandingApprovalSchema.safeParse(approval);
  if (!record.success || isAiPrincipal(record.data.approvedBy) || !record.data.scopeIds.includes(proposal.scopeId) || !record.data.actions.includes(proposal.action)) return 'proposal-only';
  if (proposal.rule.status !== 'live' || !Object.hasOwn(executors, proposal.action)) return 'proposal-only';
  return 'execute';
}
