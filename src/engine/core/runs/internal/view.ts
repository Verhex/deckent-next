import { targetQueueViewSchema } from '#engine/core/effect/index.js';
import { projectTaskBrief, projectResultBrief, taskBriefSchema, resultBriefSchema } from './brief.js';
import { handoffReceiptViewSchema, projectTaskHandoffs } from '#engine/core/handoff-observation/index.js';
import type { HandoffStartRecord } from '#engine/core/handoff-observation/index.js';
import { z } from 'zod';
import { taskQuotaHoldSchema } from './pool-observation.js';
import { workCostReportSchema, runProposalBindingSchema, authorityAdmissionSchema, acceptanceViewSchema, deriveAcceptanceView, summarizeTaskGraph, taskGraphSummarySchema, taskDependencyIds, taskDefinitionSchema, taskProgressSchema, runStateSchema, branchDecisionSchema, identitySchema, counterSchema, runSnapshotSchema, workerEffortSchema } from '#domain/index.js';
import { runPoolObservationSchema } from './pool-observation.js';
import { RunStoreError } from './store.js';
import { workerTreeExclusionSchema, type WorkerTreeExclusionRecord } from '#engine/core/workspaces/index.js';
/** Public query contract. Storage schema changes must be mapped here, never spread into the API. */
export const runViewSchema = z.object({
  targetQueue: z.object({ records: z.array(targetQueueViewSchema), truncated: z.boolean() }).strict().optional(),
  costReport: workCostReportSchema.optional(),
  authority: authorityAdmissionSchema.optional(), proposal: runProposalBindingSchema.optional(),
  schemaVersion: z.literal(3), runId: identitySchema, scopeId: identitySchema, layoutRevision: identitySchema,
  registryRevision: identitySchema, pool: runPoolObservationSchema.optional(),
  /** PARALLEL-S3 (additive): DAG summary from the same domain projection the monitor uses; always set by `projectRunView`. */
  graphSummary: taskGraphSummarySchema.optional(),
  branch: branchDecisionSchema.unwrap().omit({ sourceGraph: true }).optional(),
  criteria: z.array(z.object({ id: identitySchema, version: counterSchema.positive(), description: z.string(), evaluator: z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly()).readonly(),
  channelWaits: z.array(taskQuotaHoldSchema).readonly().optional(),
  quotaWaits: z.array(taskQuotaHoldSchema.unwrap().extend({ retryLimitReached: z.boolean() }).strict().readonly()).readonly().optional(),
  revision: counterSchema, cancellationRequested: z.boolean(), state: runStateSchema,
  tasks: z.array(z.object({
    taskBrief: taskBriefSchema.optional(), resultBrief: resultBriefSchema.optional(),
    custodyDisposition: z.enum(['hold-manual', 'released']).optional(), workerCustody: taskProgressSchema.unwrap().innerType().shape.workerCustody,
    acceptance: acceptanceViewSchema.optional(),
    id: identitySchema, kind: identitySchema, dependencies: z.array(identitySchema).readonly(),
    acceptanceCriteria: z.array(identitySchema).readonly(), handoffs: z.array(handoffReceiptViewSchema).readonly().optional(),
    /** S6 (owner 2026-10-15): hits the operator's `execution.secretGate` lists lifted for this task's attempt (path, rule, lifting entry; never a value). */
    configExclusions: z.object({ count: counterSchema.positive(), entries: z.array(workerTreeExclusionSchema).readonly() }).strict().readonly().optional(),
    inputs: taskDefinitionSchema.unwrap().shape.inputs,
    profile: z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly(),
    phase: taskProgressSchema.unwrap().innerType().shape.phase,
    notAcceptedReason: taskProgressSchema.unwrap().innerType().shape.notAcceptedReason,
    skippedReason: taskProgressSchema.unwrap().innerType().shape.skippedReason, decision: taskProgressSchema.unwrap().innerType().shape.decision, acceptedEvidence: taskProgressSchema.unwrap().innerType().shape.acceptedEvidence,
    reasoningEffort: workerEffortSchema.optional(),
    unresolvedEffects: z.boolean(),
    cancellation: z.object({ reason: z.enum(['prevented-before-launch', 'exited-under-cancellation']) }).strict().readonly().optional(),
  }).strict().readonly()).readonly(),
}).strict().readonly();
export type RunView = z.infer<typeof runViewSchema>;
export function projectRunView(input: unknown, receipts: readonly HandoffStartRecord[] = [], evaluations: readonly Readonly<{ identity: { taskId: string } }>[] = [],
  exclusions: readonly WorkerTreeExclusionRecord[] = []): RunView {
  const parsed = runSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new RunStoreError('RUN_STORE_CORRUPT');
  const run = parsed.data; const progress = new Map(run.progress.map(task => [task.taskId, task]));
  return runViewSchema.parse({ schemaVersion: 3, runId: run.identity.runId, scopeId: run.identity.scopeId,
    ...(run.proposal ? { proposal: run.proposal } : {}),
    ...(run.authority ? { authority: run.authority } : {}),
    layoutRevision: run.identity.layoutRevision, ...(run.branch ? { branch: { schemaVersion: run.branch.schemaVersion, request: run.branch.request, selectedTaskId: run.branch.selectedTaskId, notSelectedTaskId: run.branch.notSelectedTaskId } } : {}), registryRevision: run.execution.registryRevision,
    criteria: run.graph.criterionDefinitions.map(criterion => ({ id: criterion.id, version: criterion.version, description: criterion.description, evaluator: criterion.evaluator, fingerprint: run.execution.criteria.find(entry => entry.criterionId === criterion.id)!.fingerprint })),
    ...(run.quotaWaits ? { quotaWaits: run.quotaWaits.filter(wait => wait.releasedAtMs === undefined && run.bindings.some(row => row.identity.attemptId === wait.identity.attemptId)).map(wait => ({ taskId: wait.identity.taskId, since: wait.since, deadline: wait.deadline, resetsAtMs: !wait.resetBoundExceeded && wait.quota.resetsAtMs !== null && wait.quota.resetsAtMs > wait.since ? wait.quota.resetsAtMs : null, retryLimitReached: run.quotaWaits!.filter(row => row.identity.taskId === wait.identity.taskId).length > wait.maxResumes })) } : {}), revision: run.revision, cancellationRequested: run.cancelRequested, state: run.state, graphSummary: summarizeTaskGraph(run.graph, run.progress),
    tasks: run.graph.tasks.map(task => ({ acceptance: deriveAcceptanceView(run, task.id, evaluations.find(row => row.identity.taskId === task.id)), taskBrief: projectTaskBrief(run, task.id), resultBrief: projectResultBrief(run.bindings.find(binding => binding.identity.taskId === task.id)?.identity.attemptId ?? null,
      { verdict: progress.get(task.id)!.phase === 'accepted' ? progress.get(task.id)!.acceptedEvidence === 'model-unverified' ? 'accepted-unverified' : 'accepted' : null,
        ...(progress.get(task.id)!.notAcceptedReason ? { reason: progress.get(task.id)!.notAcceptedReason } : {}) }), id: task.id, kind: task.kind, dependencies: taskDependencyIds(task), acceptanceCriteria: [...task.acceptanceCriteria], ...(task.inputs ? { inputs: task.inputs } : {}),
      profile: { id: run.execution.tasks.find(entry => entry.taskId === task.id)!.profile.id, version: run.execution.tasks.find(entry => entry.taskId === task.id)!.profile.version },
      ...(() => {
        const subscription = run.execution.tasks.find(entry => entry.taskId === task.id)!.profile.parameters['nativeSubscription'];
        const parsed = workerEffortSchema.safeParse(subscription && typeof subscription === 'object' && !Array.isArray(subscription) ? (subscription as Record<string, unknown>)['reasoningEffort'] : undefined);
        return parsed.success ? { reasoningEffort: parsed.data } : {};
      })(),
      ...(progress.get(task.id)!.workerCustody ? { workerCustody: progress.get(task.id)!.workerCustody } : {}),
      ...(progress.get(task.id)!.phase === 'reconciling' ? { custodyDisposition: progress.get(task.id)!.workerCustody?.state === 'released' ? 'released' as const : 'hold-manual' as const } : {}),
      phase: progress.get(task.id)!.phase,
      ...(projectTaskHandoffs(run, task.id, receipts).length ? { handoffs: projectTaskHandoffs(run, task.id, receipts) } : {}),
      ...(() => { const record = exclusions.find(row => run.bindings.some(binding => binding.identity.taskId === task.id && binding.identity.attemptId === row.identity.attemptId));
        return record ? { configExclusions: { count: record.count, entries: record.entries } } : {}; })(),
      ...(progress.get(task.id)!.notAcceptedReason ? { notAcceptedReason: progress.get(task.id)!.notAcceptedReason } : {}),
      ...(progress.get(task.id)!.skippedReason ? { skippedReason: progress.get(task.id)!.skippedReason } : {}),
      ...(progress.get(task.id)!.decision ? { decision: progress.get(task.id)!.decision } : {}),
      ...(progress.get(task.id)!.acceptedEvidence ? { acceptedEvidence: progress.get(task.id)!.acceptedEvidence } : {}), unresolvedEffects: progress.get(task.id)!.unresolvedEffects,
      ...(progress.get(task.id)!.phase === 'cancelled' ? { cancellation: { reason: run.bindings.find(binding => binding.identity.taskId === task.id)?.observedKind === 'exited' ? 'exited-under-cancellation' : 'prevented-before-launch' } } : {}) })),
  });
}
