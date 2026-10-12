import { z } from 'zod';
import { identitySchema, clientCommandIdSchema, createImmutableJsonObjectSchema } from '#domain/core/primitives/index.js';
import { modelReferenceSchema } from '#domain/core/provider-catalog/index.js';
import protocol from './brain-protocol.json' with { type: 'json' };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Human/AI intent is a proposal request, never a Run-create authority. */
export const brainPlanCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  scopeId: identitySchema, intent: z.string().trim().min(1).max(protocol.intentMaxCodeUnits).refine(value => !value.includes('\0')),
  reference: modelReferenceSchema.optional(),
}).strict().readonly();
export type BrainPlanCommand = z.infer<typeof brainPlanCommandSchema>;
export const brainPlanCommandInputSchema = createImmutableJsonObjectSchema(protocol.commandLimits).pipe(brainPlanCommandSchema);
/** Bounded, redacted contribution attribution; the invocation retains its own immutable receipt. */
export const brainContributionSchema = z.object({ schemaVersion: z.literal(1),
  template: z.object({ id: identitySchema, version: z.number().int().positive().safe(), digest }).strict().readonly(),
  inputDigest: digest, contextDigest: digest, outputDigest: digest, requestDigest: digest,
  activationRevision: z.number().int().positive().safe(), bindingDigest: digest,
  inputSummary: z.string().max(protocol.summaryMaxCodeUnits), outputSummary: z.string().max(protocol.summaryMaxCodeUnits),
  usage: z.object({ inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
    totalTokens: z.number().int().nonnegative().safe() }).strict().readonly().nullable(),
}).strict().readonly();
export type BrainContribution = z.infer<typeof brainContributionSchema>;
