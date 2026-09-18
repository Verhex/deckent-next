import { z } from 'zod';
import { counterSchema, sanitizeIssues } from '#domain/core/primitives/index.js';
import { taskDefinitionSchema, TaskGraphError } from './contract.js';
import { criterionDefinitionSchema } from './criteria.js';
import { validateTaskGraphStructure } from './graph.js';
export const TASK_GRAPH_V2_SCHEMA_VERSION = 2;
/** Criterion identifiers are graph-scoped. Tasks may share a definition; no unresolved or unused
 * definitions survive admission. Evaluator availability and concrete parameters remain registry-owned.
 */
export const taskGraphV2Schema = z.object({
  schemaVersion: z.literal(TASK_GRAPH_V2_SCHEMA_VERSION),
  revision: counterSchema.positive(),
  tasks: z.array(taskDefinitionSchema).min(1).readonly(),
  criterionDefinitions: z.array(criterionDefinitionSchema).min(1).readonly(),
}).strict().superRefine((graph, context) => {
  const defined = new Set(graph.criterionDefinitions.map(value => value.id));
  const referenced = new Set(graph.tasks.flatMap(task => task.acceptanceCriteria));
  if (defined.size !== graph.criterionDefinitions.length || defined.size !== referenced.size || [...referenced].some(id => !defined.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'TASK_GRAPH_CRITERIA_INVALID' });
  }
}).readonly();
export type TaskGraphV2 = z.infer<typeof taskGraphV2Schema>;
export function validateTaskGraphV2(input: unknown): TaskGraphV2 {
  const parsed = taskGraphV2Schema.safeParse(input);
  if (!parsed.success) throw new TaskGraphError('TASK_GRAPH_INVALID', sanitizeIssues(parsed.error.issues));
  validateTaskGraphStructure(parsed.data);
  return parsed.data;
}
