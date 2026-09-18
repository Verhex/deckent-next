import { z } from 'zod';
import { identitySchema, counterSchema, immutableJsonObjectSchema } from '#domain/core/primitives/index.js';
/** Definition version belongs to the criterion; evaluator version selects its parameter semantics.
 * Admission must resolve that evaluator and validate concrete parameters before persisting Graph v2.
 */
export const criterionDefinitionSchema = z.object({
  id: identitySchema,
  version: counterSchema.positive(),
  description: z.string().min(1).refine(value => value.trim().length > 0),
  evaluator: z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly(),
  parameters: immutableJsonObjectSchema,
}).strict().readonly();
export type CriterionDefinition = z.infer<typeof criterionDefinitionSchema>;
