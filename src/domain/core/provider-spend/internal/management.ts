import { z } from 'zod';
import { identitySchema, immutableJsonObjectSchema, counterSchema } from '#domain/core/primitives/index.js';
import { providerSpendBudgetSchema } from './contract.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const common = { schemaVersion: z.literal(1), scopeId: identitySchema, commandId: identitySchema,
  budgetId: identitySchema, budgetRevision: counterSchema.positive(), expectedCheckpointDigest: digest };
/** Evidence is a retained external receipt digest, never console text, prompts or credentials. */
export const providerSpendManagementCommandSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('reconcile'), invocationId: identitySchema,
    resolution: z.enum(['settle', 'release', 'write-off']), exactMinorUnits: z.string().max(272),
    evidence: z.object({ kind: z.enum(['provider-usage', 'console-figure', 'write-off']), digest }).strict() }).strict(),
  z.object({ ...common, kind: z.literal('budget-revision'), budget: providerSpendBudgetSchema,
    unfreeze: z.boolean(), evidenceDigest: digest }).strict(),
]).readonly();
export const providerSpendManagementCommandInputSchema = immutableJsonObjectSchema.pipe(providerSpendManagementCommandSchema);
export function parseProviderSpendManagementCommand(input: unknown) {
  return providerSpendManagementCommandInputSchema.parse(input);
}
export type ProviderSpendManagementCommand = z.infer<typeof providerSpendManagementCommandSchema>;
