import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
import { clientCommandIdSchema } from '#domain/core/primitives/index.js';
import { modelReferenceSchema } from '#domain/core/provider-catalog/index.js';
import { providerSpendBudgetSchema } from '#domain/core/provider-spend/index.js';
import { taskGraphSchema, taskResourceSchema } from '#domain/core/task-graph/index.js';
import { brainContributionSchema } from './brain.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const proposalActorSchema = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly();
/** D2b (owner 2026-10-18): a human's per-Run delivery intent, approved with the Run. One Run, one target (the queue's target ref shape);
 * `enqueue-accepted` lets the service submit the Run's accepted Attempts to that target, re-queue a parked/expired ticket by typed cause
 * and start the bounded re-attempt. Publish/adopt remain the human's terminal cards. Additive and optional within proposal v1. */
export const runDeliveryIntentSchema = z.object({ target: taskResourceSchema, mode: z.literal('enqueue-accepted') }).strict().readonly();
export type RunDeliveryIntent = z.infer<typeof runDeliveryIntentSchema>;
export const proposalPermissionSchema = z.object({ kind: identitySchema, action: identitySchema, resourceId: identitySchema }).strict().readonly();
/** Attribution is checked against the authenticated principal; a model receipt reference never grants authority. */
export const runProposalSchema = z.object({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  proposalId: identitySchema, scopeId: identitySchema, runId: identitySchema, graph: taskGraphSchema,
  budgetCeiling: providerSpendBudgetSchema.unwrap().pick({ currency: true, limitMinorUnits: true }).readonly(),
  requiredPermissions: z.array(proposalPermissionSchema).max(256).readonly(),
  proposer: proposalActorSchema,
  delivery: runDeliveryIntentSchema.optional(),
  source: z.discriminatedUnion('kind', [z.object({ kind: z.literal('human') }).strict(),
    z.object({ kind: z.literal('model'), receipt: z.object({ commandId: clientCommandIdSchema, invocationId: identitySchema,
      reference: modelReferenceSchema, responseDigest: digest }).strict().readonly(), contribution: brainContributionSchema.optional() }).strict()]).readonly(),
}).strict().readonly();
export type RunProposal = z.infer<typeof runProposalSchema>;
export type ProposalPermission = z.infer<typeof proposalPermissionSchema>;
/** What Run admission evaluates for a proposal, derived by the system from the validated graph and never from a proposer's list (live
 * 2026-10-18: a model's invented entries refused its plan). One `task/execute` per task: the only per-task gate whose resource is known now.
 * Run create is the create decision itself; reserve, attempt execute, pool and work-target use keep their own gates at the real action. */
export function deriveProposalPermissions(graph: RunProposal['graph']): readonly ProposalPermission[] {
  return Object.freeze(graph.tasks.map(task => Object.freeze({ kind: 'task', action: 'execute', resourceId: task.id })));
}
/** The proposer's entries outside the derived set: shown as advisory on the card, never evaluated as a requirement and never a grant. */
export function advisoryProposalPermissions(declared: readonly ProposalPermission[], graph: RunProposal['graph']): readonly ProposalPermission[] {
  const derived = new Set(deriveProposalPermissions(graph).map(row => JSON.stringify([row.kind, row.action, row.resourceId])));
  return Object.freeze(declared.filter(row => !derived.has(JSON.stringify([row.kind, row.action, row.resourceId]))));
}
/** Trusted deterministic admission basis, retained by the Run and its sealed decision. Never accepted by run create ingress. */
export const runProposalBindingSchema = z.object({ schemaVersion: z.literal(1), proposalId: identitySchema, digest,
  budgetCeiling: runProposalSchema.unwrap().shape.budgetCeiling,
  requiredPermissions: z.array(proposalPermissionSchema).max(256).readonly(),
  /** The approved intent and the human who granted it (the verified human proposer); the service acts as that human's service principal. */
  delivery: runDeliveryIntentSchema.unwrap().extend({ grantedBy: proposalActorSchema }).strict().readonly().optional(),
  admission: z.object({ registryRevision: identitySchema, registryDigest: digest, standingAdmission: z.boolean(),
    budgetSemantics: z.enum(['admission-check-only', 'not-metered']).optional(), spendingDigest: digest.optional(),
    budget: z.object({ budgetId: identitySchema, budgetRevision: counterSchema.positive(), checkpointDigest: digest,
      remainingMinorUnits: counterSchema, checkedAt: counterSchema, source: z.literal('configured').optional() }).strict().readonly().nullable(),
  }).strict().refine(value => (value.budgetSemantics === 'not-metered') === (value.budget === null)).readonly().nullable(),
}).strict().readonly();
export type RunProposalBinding = z.infer<typeof runProposalBindingSchema>;
