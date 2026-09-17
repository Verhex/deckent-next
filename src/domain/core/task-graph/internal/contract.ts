import { z } from 'zod';

// Wire invariants, not configurable scheduling policy. Kind definitions live in registries.
export const TASK_GRAPH_SCHEMA_VERSION = 1;
const identity = z.string().min(1).refine(value => value.trim() === value && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
export const taskDefinitionSchema = z.object({
  id: identity,
  kind: identity,
  dependencies: z.array(identity).readonly(),
  acceptanceCriteria: z.array(identity).min(1).readonly(),
}).strict().readonly();
export const taskGraphSchema = z.object({
  schemaVersion: z.literal(TASK_GRAPH_SCHEMA_VERSION),
  revision: z.number().int().positive().safe(),
  tasks: z.array(taskDefinitionSchema).min(1).readonly(),
}).strict().readonly();
export const taskProgressSchema = z.object({
  taskId: identity,
  phase: z.enum(['pending', 'active', 'evaluating', 'accepted', 'failed', 'cancelled', 'reconciling']),
  unresolvedEffects: z.boolean(),
  eligibleAt: z.number().int().nonnegative().safe(),
}).strict().superRefine((state, context) => {
  if (state.phase === 'accepted' && state.unresolvedEffects) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'TASK_ACCEPTED_WITH_UNRESOLVED_EFFECT' });
  }
}).readonly();
export const readinessInputSchema = z.object({
  graphRevision: z.number().int().positive().safe(),
  now: z.number().int().nonnegative().safe(),
  progress: z.array(taskProgressSchema).readonly(),
}).strict();
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;
export type TaskGraph = z.infer<typeof taskGraphSchema>;
export type TaskProgress = z.infer<typeof taskProgressSchema>;
export type ReadinessInput = z.infer<typeof readinessInputSchema>;
export type TaskGraphErrorCode = 'TASK_GRAPH_INVALID' | 'TASK_DUPLICATE' | 'TASK_DEPENDENCY_DUPLICATE'
  | 'TASK_DEPENDENCY_MISSING' | 'TASK_GRAPH_CYCLE' | 'TASK_ACCEPTANCE_DUPLICATE'
  | 'TASK_PROGRESS_INVALID' | 'TASK_PROGRESS_DUPLICATE' | 'TASK_PROGRESS_INCOMPLETE' | 'TASK_GRAPH_REVISION_MISMATCH';
export class TaskGraphError extends Error {
  constructor(readonly code: TaskGraphErrorCode) { super(code); this.name = 'TaskGraphError'; }
}
