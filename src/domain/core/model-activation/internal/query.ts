import { z } from 'zod';
import { createImmutableJsonObjectSchema, identitySchema } from '#domain/core/primitives/index.js';
import { PROVIDER_CATALOG_WIRE_LIMITS, modelReferenceSchema } from '#domain/core/provider-catalog/index.js';
import { ModelActivationError, parseModelActivationReference } from './contract.js';

export const modelActivationQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  reference: modelReferenceSchema }).strict().readonly();
export type ModelActivationQuery = Readonly<z.infer<typeof modelActivationQuerySchema>>;
const envelope = createImmutableJsonObjectSchema(PROVIDER_CATALOG_WIRE_LIMITS);

export function parseModelActivationQuery(input: unknown): ModelActivationQuery {
  const copied = envelope.safeParse(input);
  if (!copied.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  const parsed = modelActivationQuerySchema.safeParse(copied.data);
  if (!parsed.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  return Object.freeze({ ...parsed.data, reference: parseModelActivationReference(parsed.data.reference) });
}
