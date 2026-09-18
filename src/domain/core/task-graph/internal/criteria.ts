import { z } from 'zod';
import { identitySchema, counterSchema, immutableJsonObjectSchema } from '#domain/core/primitives/index.js';
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
  parameters: immutableJsonObjectSchema,
}).strict().readonly();
export type CriterionDefinition = z.infer<typeof criterionDefinitionSchema>;
