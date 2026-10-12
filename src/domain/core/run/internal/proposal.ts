import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
import { clientCommandIdSchema } from '#domain/core/primitives/index.js';
import { modelReferenceSchema } from '#domain/core/provider-catalog/index.js';
import { providerSpendBudgetSchema } from '#domain/core/provider-spend/index.js';
import { taskGraphSchema } from '#domain/core/task-graph/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const proposalPermissionSchema = z.object({ kind: identitySchema, action: identitySchema, resourceId: identitySchema }).strict().readonly();
/** Attribution is checked against the authenticated principal; a model receipt reference never grants authority. */
export const runProposalSchema = z.object({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  proposalId: identitySchema, scopeId: identitySchema, runId: identitySchema, graph: taskGraphSchema,
  budgetCeiling: providerSpendBudgetSchema.unwrap().pick({ currency: true, limitMinorUnits: true }).readonly(),
  requiredPermissions: z.array(proposalPermissionSchema).max(256).readonly(),
  proposer: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly(),
  source: z.discriminatedUnion('kind', [z.object({ kind: z.literal('human') }).strict(),
    z.object({ kind: z.literal('model'), receipt: z.object({ commandId: clientCommandIdSchema, invocationId: identitySchema,
      reference: modelReferenceSchema, responseDigest: digest }).strict().readonly() }).strict()]).readonly(),
}).strict().readonly();
export type RunProposal = z.infer<typeof runProposalSchema>;
export type ProposalPermission = z.infer<typeof proposalPermissionSchema>;
/** Trusted deterministic admission basis, retained by the Run and its sealed decision. Never accepted by run create ingress. */
export const runProposalBindingSchema = z.object({ schemaVersion: z.literal(1), proposalId: identitySchema, digest,
  budgetCeiling: runProposalSchema.unwrap().shape.budgetCeiling,
  requiredPermissions: z.array(proposalPermissionSchema).max(256).readonly(),
  admission: z.object({ registryRevision: identitySchema, registryDigest: digest, standingAdmission: z.boolean(),
    budget: z.object({ budgetId: identitySchema, budgetRevision: counterSchema.positive(), checkpointDigest: digest,
      remainingMinorUnits: counterSchema, checkedAt: counterSchema }).strict().readonly(),
  }).strict().readonly().nullable(),
}).strict().readonly();
export type RunProposalBinding = z.infer<typeof runProposalBindingSchema>;
