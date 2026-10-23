import { readWorkerModelPin, quotaExhaustedSchema } from '#domain/core/worker-event/index.js';
import { runExecutionSnapshotSchema } from './registry.js';
import { z } from 'zod';
import { runProposalBindingSchema } from './proposal.js';
import { authorityAdmissionSchema, runSafetyHoldSourceSchema } from '#domain/core/audit/index.js';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
import { taskGraphSchema, taskProgressSchema, inspectTaskReadiness, branchDecisionSchema, assertAdmissionBranch } from '#domain/core/task-graph/index.js';
import { workerReportLimits } from '#domain/core/worker-event/index.js';
import environmentLimits from './environment-requirements.json' with { type: 'json' };
export const runIdentitySchema = z.object({ runId: identitySchema, scopeId: identitySchema, layoutRevision: identitySchema }).strict().readonly();
/** R3 (owner D4a/D5a): why a superseded Attempt was retried by the bounded stall recovery; only on a `stalled` previous binding. */
export const STALL_CAUSES = ['inactivity', 'report-missing', 'report-invalid'] as const;
export const runBindingSchema = z.object({ identity: attemptIdentitySchema, observedRevision: counterSchema.positive().nullable(),
  observedKind: z.enum(['started', 'exited', 'quota-exhausted', 'cancelled', 'unknown', 'handoff-refused', 'launch-refused', 'stalled']).nullable(),
  stallCause: z.enum(STALL_CAUSES).optional(),
  // REVISE 2695: the environment probes this unobserved attempt's custody covers (written before the first probe container can start).
  probes: z.array(identitySchema).max(environmentLimits.limits.requirements).readonly().optional(),
}).strict().refine(value => (value.observedKind === 'stalled') === (value.stallCause !== undefined) && (value.probes === undefined || value.observedKind === null), 'RUN_SNAPSHOT_INCONSISTENT').readonly();
/** S5b (Auditor owner decision 6): who placed a hold. `operator` is the public Run control and is never written, so earlier releases read every
 * operator hold; each safety source (Nervous pause, Auditor park) is resumed only by a person at a terminal (Y4 floor, ai-floor.ts). */
export const RUN_HOLD_SOURCES = ['operator', 'nervous', 'auditor'] as const;
export const safetyHoldSourceSchema = runSafetyHoldSourceSchema;
export type RunHoldSource = typeof RUN_HOLD_SOURCES[number];
export type SafetyHoldSource = z.infer<typeof safetyHoldSourceSchema>;
export const runStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running') }).strict(),
  z.object({ kind: z.literal('parked'), reason: z.enum(['dependency-failed', 'dependency-cancelled', 'awaiting-decision', 'evaluation-not-ready', 'needs-input', 'operator-hold', 'progression-failed', 'quota-exhausted', 'environment-not-ready']),
    failureCode: identitySchema.optional(), operatorHold: z.object({ schemaVersion: z.literal(1), note: z.string().trim().min(1).max(workerReportLimits.handoffOpenQuestionChars),
      source: safetyHoldSourceSchema.optional() }).strict().optional(),
    note: z.string().trim().min(1).max(workerReportLimits.handoffOpenQuestionChars).optional(), holdSource: safetyHoldSourceSchema.optional(), since: counterSchema, deadline: counterSchema }).strict(),
  z.object({ kind: z.literal('terminal'), outcome: z.enum(['completed', 'incomplete', 'failed', 'cancelled']), reason: z.enum(['completed', 'cancelled', 'operator-close', 'park-timeout']) }).strict(),
]).readonly();
export const runSnapshotSchema = z.object({ schemaVersion: z.literal(4), identity: runIdentitySchema, revision: counterSchema,
  proposal: runProposalBindingSchema.optional(),
  authority: authorityAdmissionSchema.optional(),
  state: runStateSchema, branch: branchDecisionSchema.optional(), graph: taskGraphSchema, execution: runExecutionSnapshotSchema, progress: z.array(taskProgressSchema).readonly(), bindings: z.array(runBindingSchema).readonly(), cancelRequested: z.boolean(),
  quotaWaits: z.array(z.object({ identity: attemptIdentitySchema, channelId: z.string().min(1).max(256), quota: quotaExhaustedSchema,
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/), since: counterSchema, deadline: counterSchema, maxResumes: counterSchema, resetBoundExceeded: z.boolean().optional(), releasedAtMs: counterSchema.optional() }).strict().readonly()).readonly().optional(),
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
    || (run.state.holdSource !== undefined && (run.state.reason !== 'operator-hold' || run.state.operatorHold !== undefined))
    || ['progression-failed', 'environment-not-ready'].includes(run.state.reason) !== (run.state.failureCode !== undefined)
    // PRE-7: an environment park names the unmet requirement (failureCode) and holds the attempt its preflight refused.
    || (run.state.reason === 'environment-not-ready' && !run.bindings.some(row => row.observedKind === 'launch-refused'))
    || (!['operator-hold', 'needs-input', 'progression-failed', 'quota-exhausted', 'environment-not-ready'].includes(run.state.reason) && run.progress.some(task => task.unresolvedEffects || ['active', 'evaluating', 'reconciling'].includes(task.phase))))) invalid();
  if (run.state.kind === 'terminal' && (run.progress.some(task => task.unresolvedEffects || ['pending', 'active', 'evaluating', 'reconciling', 'awaiting-decision'].includes(task.phase)) || (run.state.outcome === 'completed' && run.progress.some(task => task.phase !== 'accepted')) || (run.state.outcome === 'incomplete' && (!run.progress.some(task => task.phase === 'accepted') || run.progress.every(task => task.phase === 'accepted'))) || (['failed', 'cancelled'].includes(run.state.outcome) && run.progress.some(task => task.phase === 'accepted')))) invalid();
  const tasks = new Set(run.graph.tasks.map(task => task.id)); const bound = new Set<string>(); const attempts = new Set<string>();
  for (const binding of run.previousBindings ?? []) {
    const id = binding.identity;
    if (!tasks.has(id.taskId) || attempts.has(id.attemptId) || id.runId !== run.identity.runId || id.scopeId !== run.identity.scopeId
      || id.layoutRevision !== run.identity.layoutRevision || !['exited', 'quota-exhausted', 'stalled', 'launch-refused'].includes(binding.observedKind ?? '') || binding.observedRevision === null) invalid();
    attempts.add(id.attemptId);
  }
  for (const binding of run.bindings) {
    const id = binding.identity;
    if (!tasks.has(id.taskId) || bound.has(id.taskId) || attempts.has(id.attemptId) || id.runId !== run.identity.runId || id.scopeId !== run.identity.scopeId || id.layoutRevision !== run.identity.layoutRevision ||
      (binding.observedRevision === null) !== (binding.observedKind === null) || binding.observedKind === 'stalled') invalid();
    bound.add(id.taskId); attempts.add(id.attemptId);
    if (binding.probes && !run.progress.some(task => task.taskId === id.taskId && task.phase === 'active' && task.unresolvedEffects)) invalid();
  }
  const waits = run.quotaWaits ?? [];
  if (new Set(waits.map(wait => wait.identity.attemptId)).size !== waits.length) invalid();
  for (const wait of waits) {
    const binding = [...run.bindings, ...(run.previousBindings ?? [])].find(row => row.identity.attemptId === wait.identity.attemptId);
    const pin = readWorkerModelPin(run.execution.tasks.find(row => row.taskId === wait.identity.taskId)?.profile.parameters);
    if (!pin || pin.pin.channelId !== wait.channelId || !binding || binding.observedKind !== 'quota-exhausted' || JSON.stringify(binding.identity) !== JSON.stringify(wait.identity) || wait.deadline <= wait.since) invalid();
  }
  for (const binding of [...run.bindings, ...(run.previousBindings ?? [])]) if (binding.observedKind === 'quota-exhausted' && !waits.some(wait => wait.identity.attemptId === binding.identity.attemptId)) invalid();
  if (run.state.kind === 'parked' && run.state.reason === 'quota-exhausted' && !run.bindings.some(row => row.observedKind === 'quota-exhausted')) invalid();
  for (const task of run.progress) {
    if (task.inputAnswer && (task.inputAnswer.source.taskId !== task.taskId || task.inputAnswer.source.runId !== run.identity.runId
      || task.inputAnswer.source.scopeId !== run.identity.scopeId || task.inputAnswer.source.layoutRevision !== run.identity.layoutRevision)) invalid();
    const binding = run.bindings.find(value => value.identity.taskId === task.taskId);
    if (task.inputAnswer && binding && !(run.previousBindings ?? []).some(row => row.identity.taskId === task.taskId && row.identity.generation >= task.inputAnswer!.source.generation) && (binding.identity.generation !== task.inputAnswer.source.generation + 1 || binding.identity.attemptId === task.inputAnswer.source.attemptId)) invalid();
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
