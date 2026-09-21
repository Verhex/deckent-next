import { runExecutionSnapshotSchema } from './registry.js';
import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
import { taskGraphSchema, taskProgressSchema, inspectTaskReadiness, branchDecisionSchema, assertAdmissionBranch } from '#domain/core/task-graph/index.js';
export const runIdentitySchema = z.object({ runId: identitySchema, scopeId: identitySchema, layoutRevision: identitySchema }).strict().readonly();
export const runBindingSchema = z.object({ identity: attemptIdentitySchema, observedRevision: counterSchema.positive().nullable(),
  observedKind: z.enum(['started', 'exited', 'cancelled', 'unknown']).nullable(),
}).strict().readonly();
export const runSnapshotSchema = z.object({ schemaVersion: z.literal(3), identity: runIdentitySchema, revision: counterSchema,
  branch: branchDecisionSchema.optional(), graph: taskGraphSchema, execution: runExecutionSnapshotSchema, progress: z.array(taskProgressSchema).readonly(), bindings: z.array(runBindingSchema).readonly(), cancelRequested: z.boolean(),
}).strict().superRefine((run, context) => {
  const invalid = () => context.addIssue({ code: z.ZodIssueCode.custom, message: 'RUN_SNAPSHOT_INCONSISTENT' });
  try { inspectTaskReadiness(run.graph, { graphRevision: run.graph.revision, now: 0, progress: run.progress }); } catch { invalid(); return; }
  if (run.branch) { try { assertAdmissionBranch(run.graph, run.branch); } catch { invalid(); return; } }
  if (run.execution.tasks.length !== run.graph.tasks.length || run.execution.criteria.length !== run.graph.criterionDefinitions.length) invalid();
  const selectedTasks = new Set(run.execution.tasks.map(entry => entry.taskId));
  const selectedCriteria = new Set(run.execution.criteria.map(entry => entry.criterionId));
  if (selectedTasks.size !== run.execution.tasks.length || selectedCriteria.size !== run.execution.criteria.length) invalid();
  for (const task of run.graph.tasks) if (!selectedTasks.has(task.id)) invalid();
  for (const criterion of run.graph.criterionDefinitions) {
    const selected = run.execution.criteria.find(entry => entry.criterionId === criterion.id);
    if (!selected || selected.evaluator.id !== criterion.evaluator.id || selected.evaluator.version !== criterion.evaluator.version) invalid();
  }
  const tasks = new Set(run.graph.tasks.map(task => task.id)); const bound = new Set<string>(); const attempts = new Set<string>();
  for (const binding of run.bindings) {
    const id = binding.identity;
    if (!tasks.has(id.taskId) || bound.has(id.taskId) || attempts.has(id.attemptId) || id.runId !== run.identity.runId || id.scopeId !== run.identity.scopeId || id.layoutRevision !== run.identity.layoutRevision ||
      (binding.observedRevision === null) !== (binding.observedKind === null)) invalid();
    bound.add(id.taskId); attempts.add(id.attemptId);
  }
  for (const task of run.progress) if (['active', 'evaluating', 'reconciling'].includes(task.phase) && !bound.has(task.taskId)) invalid();
}).readonly();
export type RunIdentity = z.infer<typeof runIdentitySchema>;
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;
export class RunError extends Error {
  constructor(readonly code: 'RUN_INVALID' | 'RUN_REVISION_CONFLICT' | 'RUN_CANCEL_REQUESTED' | 'RUN_TASK_NOT_READY' | 'RUN_ATTEMPT_CONFLICT' | 'RUN_OBSERVATION_STALE') { super(code); this.name = 'RunError'; }
}
export function checkedRun(input: unknown, expectedRevision: number): RunSnapshot {
  const parsed = runSnapshotSchema.safeParse(input); if (!parsed.success) throw new RunError('RUN_INVALID');
  if (parsed.data.revision !== expectedRevision || !Number.isSafeInteger(expectedRevision + 1)) throw new RunError('RUN_REVISION_CONFLICT');
  return parsed.data;
}
