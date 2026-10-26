import { z } from 'zod';
import { authorityAdmissionSchema, counterSchema, identitySchema, brainPlanCommandSchema, runProposalSchema, runProposalBindingSchema,
  encodeCommandProjection, type RunProposal } from '#domain/index.js';
import { ErrorRegistry, sha256 } from '#platform/index.js';
export const runProposalQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema, commandId: identitySchema }).strict().readonly();
const plannedV1 = z.object({ schemaVersion: z.literal(1), proposal: runProposalSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/), revision: counterSchema, recordedAt: counterSchema,
  status: z.enum(['recorded', 'pending', 'accepted', 'rejected', 'parked']),
  binding: runProposalBindingSchema,
  reason: identitySchema.nullable(), approval: z.object({ approvalId: identitySchema, expiresAt: counterSchema,
    decisionRecordId: identitySchema }).strict().readonly().nullable(),
  authority: authorityAdmissionSchema.nullable(),
}).strict().readonly();
export type RunProposalQuery = z.infer<typeof runProposalQuerySchema>;
export const setupIntentFactSchema = z.object({ id: identitySchema, revision: counterSchema, basis: z.string().regex(/^[a-f0-9]{64}$/),
  ready: z.boolean(), reason: z.enum(['WORKER_SETUP_PENDING', 'WORKER_IMAGE_BUILD_FAILED', 'WORKER_IMAGE_BUILD_INTERRUPTED', 'WORKER_IMAGE_DECLINED']),
  params: z.record(z.string(), z.union([z.string().max(512), z.number().finite()])) }).strict().readonly();
export type SetupIntentFact = z.infer<typeof setupIntentFactSchema>;
export const runIntentRecordSchema = z.object({ schemaVersion: z.literal(2), kind: z.literal('intent'),
  command: brainPlanCommandSchema, proposer: runProposalSchema.unwrap().shape.proposer, proposalId: identitySchema, runId: identitySchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/), revision: counterSchema, recordedAt: counterSchema,
  status: z.enum(['parked', 'released', 'starting', 'cancelled']), fact: setupIntentFactSchema,
  transitions: z.array(z.object({ commandId: identitySchema, action: z.enum(['release', 'cancel', 'start', 'fact']),
    revision: counterSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(256) }).strict().readonly();
export type RunIntentRecord = z.infer<typeof runIntentRecordSchema>;
const plannedV2 = plannedV1.unwrap().extend({ schemaVersion: z.literal(2), kind: z.literal('planned'), origin: runIntentRecordSchema.nullable() }).strict().readonly();
export const runProposalRecordSchema = z.union([plannedV1, plannedV2]);
export type RunProposalRecord = z.infer<typeof runProposalRecordSchema>;
export type RunProposalEnvelope = RunProposalRecord | RunIntentRecord;
export const isRunIntent = (record: RunProposalEnvelope): record is RunIntentRecord => 'kind' in record && record.kind === 'intent';
export const proposalIdentity = (record: RunProposalEnvelope) => isRunIntent(record)
  ? { scopeId: record.command.scopeId, commandId: record.command.commandId, proposalId: record.proposalId, runId: record.runId } : { scopeId: record.proposal.scopeId, commandId: record.proposal.commandId, proposalId: record.proposal.proposalId, runId: record.proposal.runId };
export const runIntentDigest = (command: z.infer<typeof brainPlanCommandSchema>, proposer: RunProposal['proposer']) => sha256(encodeCommandProjection('run-intent:2', { command, proposer }));
export function parseRunProposalEnvelope(input: unknown): RunProposalEnvelope {
  if (input && typeof input === 'object' && 'kind' in input && input.kind === 'intent') {
    const r = runIntentRecordSchema.safeParse(input);
    if (!r.success || r.data.digest !== runIntentDigest(r.data.command, r.data.proposer)
      || r.data.revision !== r.data.transitions.length || r.data.transitions.some((row, index) => row.revision !== index + 1)
      || new Set(r.data.transitions.map(row => row.commandId)).size !== r.data.transitions.length) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
    return r.data;
  }
  return parseRunProposalRecord(input);
}
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
  if (r.schemaVersion === 2 && r.origin && (r.origin.status !== 'starting' || r.origin.revision >= r.revision
    || r.origin.recordedAt !== r.recordedAt || r.origin.digest !== runIntentDigest(r.origin.command, r.origin.proposer)
    || JSON.stringify(proposalIdentity(r.origin)) !== JSON.stringify(proposalIdentity(r)))) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
  if (r.digest !== runProposalDigest(r.proposal) || r.digest !== r.binding.digest || r.proposal.proposalId !== r.binding.proposalId
    || encodeCommandProjection('ceiling', r.proposal.budgetCeiling) !== encodeCommandProjection('ceiling', r.binding.budgetCeiling)
    || encodeCommandProjection('permissions', r.proposal.requiredPermissions) !== encodeCommandProjection('permissions', r.binding.requiredPermissions)
    || encodeCommandProjection('delivery', r.proposal.delivery ? { ...r.proposal.delivery, grantedBy: r.proposal.proposer } : null) !== encodeCommandProjection('delivery', r.binding.delivery ?? null)
    || (r.status === 'accepted') !== (r.authority !== null) || (r.status === 'pending') !== (r.approval !== null)
    || (['accepted', 'pending'].includes(r.status) && r.binding.admission === null)
    || (['rejected', 'parked'].includes(r.status) && r.reason === null)) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
  return r;
}
export interface RunProposalStore {
  loadProposal(scopeId: string, commandId: string): Promise<RunProposalEnvelope | null>;
  /** Same command/digest returns its durable state; different input is a conflict. */
  recordProposal(input: RunProposalEnvelope): Promise<RunProposalEnvelope>;
  /** Compare-and-set; acceptance is written by the existing Run transaction, never this application port. */
  transitionProposal(previous: RunProposalEnvelope, next: RunProposalEnvelope): Promise<RunProposalEnvelope>;
}
