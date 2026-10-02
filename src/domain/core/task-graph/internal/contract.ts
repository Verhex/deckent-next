import { z } from 'zod';
import { identitySchema as identity, counterSchema, type ValidationIssue } from '#domain/core/primitives/index.js';
import { criterionDefinitionSchema } from './criteria.js';
import { workInputSchema } from './work-input.js';

// Wire invariants, not configurable scheduling policy. Kind definitions live in registries.
// v3 (K3 = A) adds the optional typed `workInput` per task; v2 graphs stay accepted unchanged, and a v2 graph never carries one.
export const TASK_GRAPH_SCHEMA_VERSION = 3;

export const taskInputNameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

export const taskDefinitionSchema = z.object({
  id: identity,
  kind: identity,
  dependencies: z.array(identity).readonly(),
  acceptanceCriteria: z.array(identity).min(1).readonly(),
  inputs: z.array(z.object({ name: taskInputNameSchema, taskId: identity, output: taskInputNameSchema.optional() }).strict().readonly()).readonly().optional(),
  workInput: workInputSchema.optional(),
}).strict().readonly();
export const taskGraphSchema = z.object({
  schemaVersion: z.union([z.literal(2), z.literal(TASK_GRAPH_SCHEMA_VERSION)]),
  revision: counterSchema.positive(),
  tasks: z.array(taskDefinitionSchema).min(1).readonly(),
  criterionDefinitions: z.array(criterionDefinitionSchema).readonly(),
}).strict().superRefine((graph, context) => {
  graph.tasks.forEach((task, index) => {
    if (graph.schemaVersion === 2 && task.workInput !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['tasks', index, 'workInput'], message: 'TASK_GRAPH_VERSION' });
  });
}).readonly();
export const taskEligibilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('immediate') }).strict(),
  z.object({ kind: z.literal('not-before'), at: counterSchema }).strict(),
]).readonly();
export const taskProgressSchema = z.object({
  taskId: identity,
  phase: z.enum(['pending', 'active', 'evaluating', 'accepted', 'failed', 'cancelled', 'reconciling', 'skipped', 'awaiting-decision']),
  skippedReason: z.enum(['dependency-failed', 'dependency-cancelled']).optional(),
  decision: z.object({ reason: z.enum(['evaluation-unknown', 'evaluation-not-ready']), since: counterSchema, deadline: counterSchema, evaluationId: identity.optional(),
    evidenceDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2).readonly().optional() }).strict().readonly().optional(),
  acceptedEvidence: z.literal('model-unverified').optional(),
  unresolvedEffects: z.boolean(),
  eligibility: taskEligibilitySchema,
}).strict().superRefine((state, context) => {
  if ((state.phase === 'skipped') !== (state.skippedReason !== undefined) || (state.phase === 'awaiting-decision') !== (state.decision !== undefined) || (state.acceptedEvidence !== undefined && state.phase !== 'accepted') || (state.decision && state.decision.deadline <= state.decision.since)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'TASK_PROGRESS_STATE_INCONSISTENT' });
  if (['accepted', 'skipped', 'awaiting-decision'].includes(state.phase) && state.unresolvedEffects) {
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
