import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';

const actorSchema = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly();
/** Trusted durable execution context, never authored criterion parameters. `notBefore` is the earliest admissible settlement
 * instant; the engine derives it from the durable launch grant (one constructor). */
export const operationEvidenceBindingSchema = z.object({ notBefore: counterSchema,
  principals: z.array(actorSchema).min(1).max(2).readonly(),
}).strict().readonly();
export type OperationEvidenceBinding = z.infer<typeof operationEvidenceBindingSchema>;
export function operationEvidenceBindingReason(input: unknown, actorInput: unknown, observedAt?: number) {
  const binding = operationEvidenceBindingSchema.safeParse(input), actor = actorSchema.safeParse(actorInput);
  if (!binding.success || !actor.success) return 'OPERATION_EVIDENCE_CONTEXT' as const;
  if (!binding.data.principals.some(value => value.id === actor.data.id && value.issuer === actor.data.issuer
    && value.subject === actor.data.subject)) return 'OPERATION_EVIDENCE_PRINCIPAL' as const;
  if (observedAt !== undefined && observedAt < binding.data.notBefore) return 'OPERATION_EVIDENCE_EARLIER' as const;
  return undefined;
}
