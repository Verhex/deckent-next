import { runExecutionSnapshotSchema } from './registry.js';
import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
import { taskGraphSchema, taskProgressSchema, inspectTaskReadiness, branchDecisionSchema, assertAdmissionBranch } from '#domain/core/task-graph/index.js';
import { workerReportLimits } from '#domain/core/worker-event/index.js';
export const runIdentitySchema = z.object({ runId: identitySchema, scopeId: identitySchema, layoutRevision: identitySchema }).strict().readonly();
export const runBindingSchema = z.object({ identity: attemptIdentitySchema, observedRevision: counterSchema.positive().nullable(),
  observedKind: z.enum(['started', 'exited', 'cancelled', 'unknown', 'handoff-refused', 'launch-refused']).nullable(),
}).strict().readonly();
export const runStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running') }).strict(),
  z.object({ kind: z.literal('parked'), reason: z.enum(['dependency-failed', 'dependency-cancelled', 'awaiting-decision', 'evaluation-not-ready', 'needs-input', 'operator-hold', 'progression-failed']),
    failureCode: identitySchema.optional(),
    note: z.string().trim().min(1).max(workerReportLimits.handoffOpenQuestionChars).optional(), since: counterSchema, deadline: counterSchema }).strict(),
  z.object({ kind: z.literal('terminal'), outcome: z.enum(['completed', 'incomplete', 'failed', 'cancelled']), reason: z.enum(['completed', 'cancelled', 'operator-close', 'park-timeout']) }).strict(),
]).readonly();
export const runSnapshotSchema = z.object({ schemaVersion: z.literal(4), identity: runIdentitySchema, revision: counterSchema,
  state: runStateSchema, branch: branchDecisionSchema.optional(), graph: taskGraphSchema, execution: runExecutionSnapshotSchema, progress: z.array(taskProgressSchema).readonly(), bindings: z.array(runBindingSchema).readonly(), cancelRequested: z.boolean(),
  previousBindings: z.array(runBindingSchema).readonly().optional(),
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
  if (run.state.kind === 'parked' && (run.state.deadline <= run.state.since || (run.state.reason === 'operator-hold') !== (run.state.note !== undefined)
    || (run.state.reason === 'progression-failed') !== (run.state.failureCode !== undefined)
    || (!['operator-hold', 'needs-input', 'progression-failed'].includes(run.state.reason) && run.progress.some(task => task.unresolvedEffects || ['active', 'evaluating', 'reconciling'].includes(task.phase))))) invalid();
  if (run.state.kind === 'terminal' && (run.progress.some(task => task.unresolvedEffects || ['pending', 'active', 'evaluating', 'reconciling', 'awaiting-decision'].includes(task.phase)) || (run.state.outcome === 'completed' && run.progress.some(task => task.phase !== 'accepted')) || (run.state.outcome === 'incomplete' && (!run.progress.some(task => task.phase === 'accepted') || run.progress.every(task => task.phase === 'accepted'))) || (['failed', 'cancelled'].includes(run.state.outcome) && run.progress.some(task => task.phase === 'accepted')))) invalid();
  const tasks = new Set(run.graph.tasks.map(task => task.id)); const bound = new Set<string>(); const attempts = new Set<string>();
  for (const binding of run.previousBindings ?? []) {
    const id = binding.identity;
    if (!tasks.has(id.taskId) || attempts.has(id.attemptId) || id.runId !== run.identity.runId || id.scopeId !== run.identity.scopeId
      || id.layoutRevision !== run.identity.layoutRevision || binding.observedKind !== 'exited' || binding.observedRevision === null) invalid();
    attempts.add(id.attemptId);
  }
  for (const binding of run.bindings) {
    const id = binding.identity;
    if (!tasks.has(id.taskId) || bound.has(id.taskId) || attempts.has(id.attemptId) || id.runId !== run.identity.runId || id.scopeId !== run.identity.scopeId || id.layoutRevision !== run.identity.layoutRevision ||
      (binding.observedRevision === null) !== (binding.observedKind === null)) invalid();
    bound.add(id.taskId); attempts.add(id.attemptId);
  }
  for (const task of run.progress) {
    if (task.inputAnswer && (task.inputAnswer.source.taskId !== task.taskId || task.inputAnswer.source.runId !== run.identity.runId
      || task.inputAnswer.source.scopeId !== run.identity.scopeId || task.inputAnswer.source.layoutRevision !== run.identity.layoutRevision)) invalid();
    const binding = run.bindings.find(value => value.identity.taskId === task.taskId);
    if (task.inputAnswer && binding && (binding.identity.generation !== task.inputAnswer.source.generation + 1 || binding.identity.attemptId === task.inputAnswer.source.attemptId)) invalid();
    if (['active', 'evaluating', 'reconciling', 'awaiting-decision'].includes(task.phase) && !bound.has(task.taskId)) invalid();
    if (task.phase === 'awaiting-decision' && run.bindings.find(binding => binding.identity.taskId === task.taskId)?.observedKind !== 'exited') invalid();
  }
}).readonly();
export type RunIdentity = z.infer<typeof runIdentitySchema>;
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;
export class RunError extends Error {
  constructor(readonly code: 'RUN_INVALID' | 'RUN_REVISION_CONFLICT' | 'RUN_CANCEL_REQUESTED' | 'RUN_TASK_NOT_READY' | 'RUN_ATTEMPT_CONFLICT' | 'RUN_OBSERVATION_STALE' | 'RUN_PARKED' | 'RUN_TERMINAL' | 'RUN_NOT_PARKED' | 'RUN_DECISION_NOT_READY' | 'RUN_DECISION_EXPIRED') { super(code); this.name = 'RunError'; }
}
export function checkedRun(input: unknown, expectedRevision: number): RunSnapshot {
  const parsed = runSnapshotSchema.safeParse(input); if (!parsed.success) throw new RunError('RUN_INVALID');
  if (parsed.data.revision !== expectedRevision || !Number.isSafeInteger(expectedRevision + 1)) throw new RunError('RUN_REVISION_CONFLICT');
  return parsed.data;
}
