import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';

const actorSchema = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly();
/** Trusted durable execution context, never authored criterion parameters. `notBefore` is the earliest admissible settlement
 * instant for a new settlement; exact already accepted same-Run references permit explicit sharing.
 * The engine derives the boundary from the durable launch grant (one constructor). */
export const operationEvidenceBindingSchema = z.object({ notBefore: counterSchema,
  principals: z.array(actorSchema).min(1).max(2).readonly(),
  /** Exact settlements already accepted by this Run, derived from its immutable evaluation receipts. */
  acceptedSettlements: z.array(z.object({ commandId: identitySchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly()).readonly().optional(),
}).strict().readonly();
export type OperationEvidenceBinding = z.infer<typeof operationEvidenceBindingSchema>;
export function operationEvidenceBindingReason(input: unknown, actorInput: unknown, observedAt?: number, settlement?: Readonly<{ commandId: string; digest: string }>) {
  const binding = operationEvidenceBindingSchema.safeParse(input), actor = actorSchema.safeParse(actorInput);
  if (!binding.success || !actor.success) return 'OPERATION_EVIDENCE_CONTEXT' as const;
  if (!binding.data.principals.some(value => value.id === actor.data.id && value.issuer === actor.data.issuer
    && value.subject === actor.data.subject)) return 'OPERATION_EVIDENCE_PRINCIPAL' as const;
  if (observedAt !== undefined && observedAt < binding.data.notBefore
    && !binding.data.acceptedSettlements?.some(value => value.commandId === settlement?.commandId && value.digest === settlement.digest)) return 'OPERATION_EVIDENCE_EARLIER' as const;
  return undefined;
}
