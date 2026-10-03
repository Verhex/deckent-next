import { handoffReceiptViewSchema, projectTaskHandoffs } from '#engine/core/handoff-observation/index.js';
import type { HandoffStartRecord } from '#engine/core/handoff-observation/index.js';
import { z } from 'zod';
import { taskDependencyIds, taskDefinitionSchema, taskProgressSchema, runStateSchema, branchDecisionSchema, identitySchema, counterSchema, runSnapshotSchema } from '#domain/index.js';
import { runPoolObservationSchema } from './pool-observation.js';
import { RunStoreError } from './store.js';
/** Public query contract. Storage schema changes must be mapped here, never spread into the API. */
export const runViewSchema = z.object({
  schemaVersion: z.literal(3), runId: identitySchema, scopeId: identitySchema, layoutRevision: identitySchema,
  registryRevision: identitySchema, pool: runPoolObservationSchema.optional(),
  branch: branchDecisionSchema.unwrap().omit({ sourceGraph: true }).optional(),
  criteria: z.array(z.object({ id: identitySchema, version: counterSchema.positive(), description: z.string(), evaluator: z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly()).readonly(),
  revision: counterSchema, cancellationRequested: z.boolean(), state: runStateSchema,
  tasks: z.array(z.object({
    id: identitySchema, kind: identitySchema, dependencies: z.array(identitySchema).readonly(),
    acceptanceCriteria: z.array(identitySchema).readonly(), handoffs: z.array(handoffReceiptViewSchema).readonly().optional(),
    inputs: taskDefinitionSchema.unwrap().shape.inputs,
    profile: z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly(),
    phase: taskProgressSchema.unwrap().innerType().shape.phase,
    notAcceptedReason: taskProgressSchema.unwrap().innerType().shape.notAcceptedReason,
    skippedReason: taskProgressSchema.unwrap().innerType().shape.skippedReason, decision: taskProgressSchema.unwrap().innerType().shape.decision, acceptedEvidence: taskProgressSchema.unwrap().innerType().shape.acceptedEvidence,
    unresolvedEffects: z.boolean(),
    cancellation: z.object({ reason: z.enum(['prevented-before-launch', 'exited-under-cancellation']) }).strict().readonly().optional(),
  }).strict().readonly()).readonly(),
}).strict().readonly();
export type RunView = z.infer<typeof runViewSchema>;
export function projectRunView(input: unknown, receipts: readonly HandoffStartRecord[] = []): RunView {
  const parsed = runSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new RunStoreError('RUN_STORE_CORRUPT');
  const run = parsed.data; const progress = new Map(run.progress.map(task => [task.taskId, task]));
  return runViewSchema.parse({ schemaVersion: 3, runId: run.identity.runId, scopeId: run.identity.scopeId,
    layoutRevision: run.identity.layoutRevision, ...(run.branch ? { branch: { schemaVersion: run.branch.schemaVersion, request: run.branch.request, selectedTaskId: run.branch.selectedTaskId, notSelectedTaskId: run.branch.notSelectedTaskId } } : {}), registryRevision: run.execution.registryRevision,
    criteria: run.graph.criterionDefinitions.map(criterion => ({ id: criterion.id, version: criterion.version, description: criterion.description, evaluator: criterion.evaluator, fingerprint: run.execution.criteria.find(entry => entry.criterionId === criterion.id)!.fingerprint })),
    revision: run.revision, cancellationRequested: run.cancelRequested, state: run.state,
    tasks: run.graph.tasks.map(task => ({ id: task.id, kind: task.kind, dependencies: taskDependencyIds(task), acceptanceCriteria: [...task.acceptanceCriteria], ...(task.inputs ? { inputs: task.inputs } : {}),
      profile: { id: run.execution.tasks.find(entry => entry.taskId === task.id)!.profile.id, version: run.execution.tasks.find(entry => entry.taskId === task.id)!.profile.version },
      phase: progress.get(task.id)!.phase,
      ...(projectTaskHandoffs(run, task.id, receipts).length ? { handoffs: projectTaskHandoffs(run, task.id, receipts) } : {}),
      ...(progress.get(task.id)!.notAcceptedReason ? { notAcceptedReason: progress.get(task.id)!.notAcceptedReason } : {}),
      ...(progress.get(task.id)!.skippedReason ? { skippedReason: progress.get(task.id)!.skippedReason } : {}),
      ...(progress.get(task.id)!.decision ? { decision: progress.get(task.id)!.decision } : {}),
      ...(progress.get(task.id)!.acceptedEvidence ? { acceptedEvidence: progress.get(task.id)!.acceptedEvidence } : {}), unresolvedEffects: progress.get(task.id)!.unresolvedEffects,
      ...(progress.get(task.id)!.phase === 'cancelled' ? { cancellation: { reason: run.bindings.find(binding => binding.identity.taskId === task.id)?.observedKind === 'exited' ? 'exited-under-cancellation' : 'prevented-before-launch' } } : {}) })),
  });
}
