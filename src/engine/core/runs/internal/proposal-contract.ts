import { z } from 'zod';
import { authorityAdmissionSchema, counterSchema, identitySchema, runProposalSchema, runProposalBindingSchema,
  encodeCommandProjection, type RunProposal } from '#domain/index.js';
import { ErrorRegistry, sha256 } from '#platform/index.js';
export const runProposalQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema, commandId: identitySchema }).strict().readonly();
export const runProposalRecordSchema = z.object({ schemaVersion: z.literal(1), proposal: runProposalSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/), revision: counterSchema, recordedAt: counterSchema,
  status: z.enum(['recorded', 'pending', 'accepted', 'rejected', 'parked']),
  binding: runProposalBindingSchema,
  reason: identitySchema.nullable(), approval: z.object({ approvalId: identitySchema, expiresAt: counterSchema,
    decisionRecordId: identitySchema }).strict().readonly().nullable(),
  authority: authorityAdmissionSchema.nullable(),
}).strict().readonly();
export type RunProposalQuery = z.infer<typeof runProposalQuerySchema>;
export type RunProposalRecord = z.infer<typeof runProposalRecordSchema>;
export const runProposalDigest = (proposal: RunProposal) => sha256(encodeCommandProjection('run-proposal:1', proposal));
export function parseRunProposal(input: unknown): RunProposal {
  if (input && typeof input === 'object' && 'schemaVersion' in input && input.schemaVersion !== 1) throw ErrorRegistry.createError('RUN_PROPOSAL_VERSION');
  const parsed = runProposalSchema.safeParse(input);
  if (!parsed.success) throw ErrorRegistry.createError('RUN_PROPOSAL_INVALID');
  return parsed.data;
}
export function parseRunProposalRecord(input: unknown): RunProposalRecord {
  const parsed = runProposalRecordSchema.safeParse(input);
  if (!parsed.success) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
  const r = parsed.data;
  if (r.digest !== runProposalDigest(r.proposal) || r.digest !== r.binding.digest || r.proposal.proposalId !== r.binding.proposalId
    || encodeCommandProjection('ceiling', r.proposal.budgetCeiling) !== encodeCommandProjection('ceiling', r.binding.budgetCeiling)
    || encodeCommandProjection('permissions', r.proposal.requiredPermissions) !== encodeCommandProjection('permissions', r.binding.requiredPermissions)
    || (r.status === 'accepted') !== (r.authority !== null) || (r.status === 'pending') !== (r.approval !== null)
    || (['accepted', 'pending'].includes(r.status) && r.binding.admission === null)
    || (['rejected', 'parked'].includes(r.status) && r.reason === null)) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
  return r;
}
export interface RunProposalStore {
  loadProposal(scopeId: string, commandId: string): Promise<RunProposalRecord | null>;
  /** Same command/digest returns its durable state; different input is a conflict. */
  recordProposal(input: RunProposalRecord): Promise<RunProposalRecord>;
  /** Compare-and-set; acceptance is written by the existing Run transaction, never this application port. */
  transitionProposal(previous: RunProposalRecord, next: RunProposalRecord): Promise<RunProposalRecord>;
}
