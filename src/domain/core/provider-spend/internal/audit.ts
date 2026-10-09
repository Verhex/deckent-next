import { z } from 'zod';
import { identitySchema, immutableJsonObjectSchema } from '#domain/core/primitives/index.js';
import { providerSpendExactAccountQuerySchema } from './contract.js';

const checkpointDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const providerSpendAuditCommandSchema = providerSpendExactAccountQuerySchema.unwrap().innerType().omit({ holds: true }).extend({ schemaVersion: z.literal(1),
  commandId: identitySchema, expectedCheckpointDigest: checkpointDigestSchema,
}).strict().readonly();

export const providerSpendAuditCommandInputSchema = immutableJsonObjectSchema.pipe(providerSpendAuditCommandSchema);

export function parseProviderSpendAuditCommand(input: unknown): ProviderSpendAuditCommand {
  return providerSpendAuditCommandInputSchema.parse(input);
}

export type ProviderSpendAuditCommand = z.infer<typeof providerSpendAuditCommandSchema>;
