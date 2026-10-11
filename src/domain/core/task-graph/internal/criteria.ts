import { z } from 'zod';
import { identitySchema, counterSchema, immutableJsonObjectSchema, type JsonObject } from '#domain/core/primitives/index.js';
export const criterionTypeSchema = z.enum(['completion', 'correctness', 'safety', 'authorization']);
export const coreEvidenceTypeSchema = z.enum(['retained-artifact', 'verification-result', 'operation-settlement', 'observed-readback', 'approval-receipt']);
export const evidenceTypeSchema = z.union([coreEvidenceTypeSchema, z.string().regex(/^ext:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)]);
export const criterionAcceptanceSchema = z.object({ criterionType: criterionTypeSchema,
  evidenceTypes: z.array(evidenceTypeSchema).min(1).max(256).readonly(),
}).strict().refine(value => new Set(value.evidenceTypes).size === value.evidenceTypes.length).readonly();
/** Version-1 text safety bound; description is explanatory, evaluator rules live in parameters. */
export const CRITERION_TEXT_LIMITS = Object.freeze({ maxCodeUnits: 4096 });
/** Definition version belongs to the criterion; evaluator version selects its parameter semantics.
 * Admission must resolve that evaluator and validate concrete parameters before persisting Graph v2.
 */
export const criterionDefinitionSchema = z.object({
  id: identitySchema,
  version: counterSchema.positive(),
  description: z.string().min(1).max(CRITERION_TEXT_LIMITS.maxCodeUnits).refine(value => value.trim().length > 0 &&
    ![...value].some(char => { const code = char.charCodeAt(0); return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159); })),
  evaluator: z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly(),
  parameters: immutableJsonObjectSchema, acceptance: criterionAcceptanceSchema.optional(),
}).strict().transform(value => {
  const { acceptance, ...rest } = value;
  // Optional metadata is omitted from old encodings, never serialized as undefined.
  return Object.freeze({ ...rest, ...(acceptance ? { acceptance } : {}) }) as typeof value & JsonObject;
}).readonly();
export type CriterionDefinition = z.infer<typeof criterionDefinitionSchema>;
