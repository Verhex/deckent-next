import { z } from 'zod';
import { CodedError, persistedString, identitySchema as identity, counterSchema, type ValidationIssue } from '#domain/core/primitives/index.js';
import { criterionDefinitionSchema } from './criteria.js';
import { workInputSchema } from './work-input.js';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
import { workerNeedsInputSchema, workerReportLimits } from '#domain/core/worker-event/index.js';

// Wire invariants, not configurable scheduling policy. Kind definitions live in registries.
// v4 adds explicit accepted-patch dependency edges. Read migration accepts v2/v3 unchanged: their string edges keep fixed-base semantics.
export const TASK_GRAPH_SCHEMA_VERSION = 4;
/** v5 (alpha.47 R4, owner D7a), additive: the system's `origin: 'scope-conflict'` order edge and a task's declared record `resources`.
 * v2–v4 read unchanged; authors write v4 (v5 only to declare `resources`); the system raises a graph to v5 only when it inserts an edge. */
export const TASK_GRAPH_RESOURCE_SCHEMA_VERSION = 5;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const taskDependencySchema = z.union([identity, z.strictObject({ taskId: identity, get startFrom() { return z.literal('accepted-patch').optional(); },
  get origin() { return z.literal('scope-conflict').optional(); } }).refine(edge => !edge.origin || edge.startFrom === 'accepted-patch').readonly()]);
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type TaskDependency = z.infer<typeof taskDependencySchema>;
export function dependencyTaskId(edge: TaskDependency): string { return typeof edge === 'string' ? edge : edge.taskId; }
export function taskDependencyIds(task: { readonly dependencies: readonly TaskDependency[] }): readonly string[] { return task.dependencies.map(dependencyTaskId); }
/** A system scope-conflict edge orders work only: a failed, cancelled or skipped predecessor releases the dependent (it starts from base). */
export function isConflictEdge(edge: TaskDependency): boolean { return typeof edge !== 'string' && edge.origin === 'scope-conflict'; }
/** Edges whose unavailable predecessor skips the dependent: every edge except a scope-conflict order edge. */
export function blockingDependencyIds(task: { readonly dependencies: readonly TaskDependency[] }): readonly string[] {
  return task.dependencies.filter(edge => !isConflictEdge(edge)).map(dependencyTaskId);
}
/** One business record a task declares it changes (ERP/CRM kind + id; same shape as an effect target ref). Orders work only (v5). */
export const taskResourceSchema = z.strictObject({ kind: identity, get id() { return persistedString(z.string().min(1).max(512))
  .refine(value => ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)); } }).readonly();

export const taskInputNameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

export const taskDefinitionSchema = z.strictObject({
  id: identity,
  kind: identity,
  get workClass() { return identity.optional(); },
  get dependencies() { return z.array(taskDependencySchema).readonly(); },
  get acceptanceCriteria() { return z.array(identity).min(1).readonly().describe('Only criterionDefinitions ids, never descriptions or sentences.'); },
  get inputs() { return z.array(z.strictObject({ name: taskInputNameSchema, taskId: identity, output: taskInputNameSchema.optional() }).readonly()).readonly().optional(); },
  get workInput() { return workInputSchema.optional(); },
  get resources() { return z.array(taskResourceSchema).min(1).max(64).readonly().optional(); },
}).readonly();
export const taskGraphSchema = z.strictObject({
  get schemaVersion() { return z.union([z.literal(2), z.literal(3), z.literal(TASK_GRAPH_SCHEMA_VERSION), z.literal(TASK_GRAPH_RESOURCE_SCHEMA_VERSION)]); },
  get revision() { return counterSchema.positive(); },
  get tasks() { return z.array(taskDefinitionSchema).min(1).readonly(); },
  get criterionDefinitions() { return z.array(criterionDefinitionSchema).readonly(); },
}).superRefine((graph, context) => {
  graph.tasks.forEach((task, index) => {
    if (graph.schemaVersion < TASK_GRAPH_SCHEMA_VERSION && task.dependencies.some(edge => typeof edge !== 'string')) context.addIssue({ code: z.ZodIssueCode.custom, path: ['tasks', index, 'dependencies'], message: 'TASK_GRAPH_VERSION' });
    if (graph.schemaVersion < TASK_GRAPH_RESOURCE_SCHEMA_VERSION && (task.resources !== undefined || task.dependencies.some(isConflictEdge))) context.addIssue({ code: z.ZodIssueCode.custom, path: ['tasks', index], message: 'TASK_GRAPH_VERSION' });
    if (task.resources && new Set(task.resources.map(ref => JSON.stringify([ref.kind, ref.id]))).size !== task.resources.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['tasks', index, 'resources'], message: 'duplicate' });
    if (graph.schemaVersion === 2 && task.workInput !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['tasks', index, 'workInput'], message: 'TASK_GRAPH_VERSION' });
  });
}).readonly();
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const taskEligibilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ get kind() { return z.literal('immediate'); } }),
  z.strictObject({ get kind() { return z.literal('not-before'); }, at: counterSchema }),
]).readonly();
/** Typed causes of a failed Task (additive literals). `report-missing`/`report-invalid` (R5, owner D5a): a work task ended without a valid
 * structured result report; `declared-check-not-passed`: its report's acceptance check did not pass; `worker-stalled` (R3): the
 * bounded silence retry is exhausted; `acceptance-check-not-run` (PRE-7): its report says an acceptance check was not run (an observed
 * claim, not an environment verdict). Only report-missing/report-invalid are retried by the run recovery owner (R3). */
export const TASK_NOT_ACCEPTED_REASONS = ['no-change-produced', 'report-missing', 'report-invalid', 'declared-check-not-passed', 'worker-stalled', 'acceptance-check-not-run'] as const;
export type TaskNotAcceptedReason = typeof TASK_NOT_ACCEPTED_REASONS[number];
export const taskProgressSchema = z.strictObject({
  taskId: identity,
  get phase() { return z.enum(['pending', 'active', 'evaluating', 'accepted', 'failed', 'cancelled', 'reconciling', 'skipped', 'awaiting-decision']); },
  get skippedReason() { return z.enum(['dependency-failed', 'dependency-cancelled']).optional(); },
  get decision() { return z.strictObject({ reason: z.enum(['evaluation-unknown', 'evaluation-not-ready', 'needs-input']), since: counterSchema, deadline: counterSchema, evaluationId: identity.optional(),
    question: workerNeedsInputSchema.unwrap().shape.question.optional(),
    evidenceDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(4).readonly().optional() }).readonly().optional(); },
  get notAcceptedReason() { return z.enum(TASK_NOT_ACCEPTED_REASONS).optional(); },
  get acceptedEvidence() { return z.literal('model-unverified').optional(); },
  get inputAnswer() { return z.strictObject({ schemaVersion: z.literal(1), source: attemptIdentitySchema, question: workerNeedsInputSchema.unwrap().shape.question,
    answer: persistedString(z.string().trim().min(1).max(workerReportLimits.handoffSummaryChars)) }).readonly().optional(); },
  get workerCustody() { return z.strictObject({ schemaVersion: z.literal(1), state: z.enum(['held', 'released']),
    basis: z.enum(['termination-proof', 'manual-decision']), fenceReceiptId: identity,
    proofReceiptId: identity.optional(), decisionReceiptId: identity.optional(),
  }).refine(value => value.basis === 'termination-proof' ? value.proofReceiptId !== undefined && value.decisionReceiptId === undefined
    : value.decisionReceiptId !== undefined && value.proofReceiptId === undefined).readonly().optional(); },
  get unresolvedEffects() { return z.boolean(); },
  eligibility: taskEligibilitySchema,
}).superRefine((state, context) => {
  if (state.decision && ((state.decision.reason === 'needs-input') !== (state.decision.question !== undefined))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'TASK_PROGRESS_STATE_INCONSISTENT' });
  if ((state.notAcceptedReason !== undefined && state.phase !== 'failed') || (state.phase === 'skipped') !== (state.skippedReason !== undefined) || (state.phase === 'awaiting-decision') !== (state.decision !== undefined) || (state.acceptedEvidence !== undefined && state.phase !== 'accepted') || (state.decision && state.decision.deadline <= state.decision.since)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'TASK_PROGRESS_STATE_INCONSISTENT' });
  if (['accepted', 'skipped', 'awaiting-decision'].includes(state.phase) && state.unresolvedEffects) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'TASK_ACCEPTED_WITH_UNRESOLVED_EFFECT' });
  }
}).readonly();
export const readinessInputSchema = z.strictObject({
  get graphRevision() { return counterSchema.positive(); },
  now: counterSchema,
  get progress() { return z.array(taskProgressSchema).readonly(); },
}).readonly();
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;
export type TaskGraph = z.infer<typeof taskGraphSchema>;
export type TaskProgress = z.infer<typeof taskProgressSchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type TaskEligibility = z.infer<typeof taskEligibilitySchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type ReadinessInput = z.infer<typeof readinessInputSchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type TaskGraphErrorCode = 'TASK_GRAPH_INVALID' | 'TASK_DUPLICATE' | 'TASK_DEPENDENCY_DUPLICATE'
  | 'TASK_DEPENDENCY_MISSING' | 'TASK_GRAPH_CYCLE' | 'TASK_ACCEPTANCE_DUPLICATE'
  | 'TASK_CRITERION_DEFINITION_MISSING' | 'TASK_CRITERION_DEFINITION_UNUSED' | 'TASK_CRITERION_DEFINITION_DUPLICATE'
  | 'TASK_PROGRESS_INVALID' | 'TASK_PROGRESS_DUPLICATE' | 'TASK_PROGRESS_INCOMPLETE' | 'TASK_GRAPH_REVISION_MISMATCH';
export class TaskGraphError extends CodedError {
  constructor(override readonly code: TaskGraphErrorCode, readonly issues: readonly ValidationIssue[] = []) { super(code); this.name = 'TaskGraphError'; }
}
