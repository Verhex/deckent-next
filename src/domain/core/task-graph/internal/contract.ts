import { z } from 'zod';
import { identitySchema as identity, counterSchema, type ValidationIssue } from '#domain/core/primitives/index.js';
import { criterionDefinitionSchema } from './criteria.js';

// Wire invariants, not configurable scheduling policy. Kind definitions live in registries.
export const TASK_GRAPH_SCHEMA_VERSION = 2;

export const taskDefinitionSchema = z.object({
  id: identity,
  kind: identity,
  dependencies: z.array(identity).readonly(),
  acceptanceCriteria: z.array(identity).min(1).readonly(),
}).strict().readonly();
export const taskGraphSchema = z.object({
  schemaVersion: z.literal(TASK_GRAPH_SCHEMA_VERSION),
  revision: counterSchema.positive(),
  tasks: z.array(taskDefinitionSchema).min(1).readonly(),
  criterionDefinitions: z.array(criterionDefinitionSchema).readonly(),
}).strict().readonly();
export const taskEligibilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('immediate') }).strict(),
  z.object({ kind: z.literal('not-before'), at: counterSchema }).strict(),
]).readonly();
export const taskProgressSchema = z.object({
  taskId: identity,
  phase: z.enum(['pending', 'active', 'evaluating', 'accepted', 'failed', 'cancelled', 'reconciling']),
  unresolvedEffects: z.boolean(),
  eligibility: taskEligibilitySchema,
}).strict().superRefine((state, context) => {
  if (state.phase === 'accepted' && state.unresolvedEffects) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'TASK_ACCEPTED_WITH_UNRESOLVED_EFFECT' });
  }
}).readonly();
export const readinessInputSchema = z.object({
  graphRevision: counterSchema.positive(),
  now: counterSchema,
  progress: z.array(taskProgressSchema).readonly(),
}).strict().readonly();
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;
export type TaskGraph = z.infer<typeof taskGraphSchema>;
export type TaskProgress = z.infer<typeof taskProgressSchema>;
export type TaskEligibility = z.infer<typeof taskEligibilitySchema>;
export type ReadinessInput = z.infer<typeof readinessInputSchema>;
export type TaskGraphErrorCode = 'TASK_GRAPH_INVALID' | 'TASK_DUPLICATE' | 'TASK_DEPENDENCY_DUPLICATE'
  | 'TASK_DEPENDENCY_MISSING' | 'TASK_GRAPH_CYCLE' | 'TASK_ACCEPTANCE_DUPLICATE'
  | 'TASK_CRITERION_DEFINITION_MISSING' | 'TASK_CRITERION_DEFINITION_UNUSED' | 'TASK_CRITERION_DEFINITION_DUPLICATE'
  | 'TASK_PROGRESS_INVALID' | 'TASK_PROGRESS_DUPLICATE' | 'TASK_PROGRESS_INCOMPLETE' | 'TASK_GRAPH_REVISION_MISMATCH';
export class TaskGraphError extends Error {
  constructor(readonly code: TaskGraphErrorCode, readonly issues: readonly ValidationIssue[] = []) { super(code); this.name = 'TaskGraphError'; }
}
