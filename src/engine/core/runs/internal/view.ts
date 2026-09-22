import { z } from 'zod';
import { taskDefinitionSchema, branchDecisionSchema, identitySchema, counterSchema, runSnapshotSchema } from '#domain/index.js';
import { RunStoreError } from './store.js';
/** Public query contract. Storage schema changes must be mapped here, never spread into the API. */
export const runViewSchema = z.object({
  schemaVersion: z.literal(2), runId: identitySchema, scopeId: identitySchema, layoutRevision: identitySchema,
  registryRevision: identitySchema,
  branch: branchDecisionSchema.unwrap().omit({ sourceGraph: true }).optional(),
  criteria: z.array(z.object({ id: identitySchema, version: counterSchema.positive(), description: z.string(), evaluator: z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly()).readonly(),
  revision: counterSchema, cancellationRequested: z.boolean(),
  tasks: z.array(z.object({
    id: identitySchema, kind: identitySchema, dependencies: z.array(identitySchema).readonly(),
    acceptanceCriteria: z.array(identitySchema).readonly(),
    inputs: taskDefinitionSchema.unwrap().shape.inputs,
    profile: z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly(),
    phase: z.enum(['pending', 'active', 'evaluating', 'accepted', 'failed', 'cancelled', 'reconciling']),
    unresolvedEffects: z.boolean(),
    cancellation: z.object({ reason: z.enum(['prevented-before-launch', 'exited-under-cancellation']) }).strict().readonly().optional(),
  }).strict().readonly()).readonly(),
}).strict().readonly();
export type RunView = z.infer<typeof runViewSchema>;
export function projectRunView(input: unknown): RunView {
  const parsed = runSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new RunStoreError('RUN_STORE_CORRUPT');
  const run = parsed.data; const progress = new Map(run.progress.map(task => [task.taskId, task]));
  return runViewSchema.parse({ schemaVersion: 2, runId: run.identity.runId, scopeId: run.identity.scopeId,
    layoutRevision: run.identity.layoutRevision, ...(run.branch ? { branch: { schemaVersion: run.branch.schemaVersion, request: run.branch.request, selectedTaskId: run.branch.selectedTaskId, notSelectedTaskId: run.branch.notSelectedTaskId } } : {}), registryRevision: run.execution.registryRevision,
    criteria: run.graph.criterionDefinitions.map(criterion => ({ id: criterion.id, version: criterion.version, description: criterion.description, evaluator: criterion.evaluator, fingerprint: run.execution.criteria.find(entry => entry.criterionId === criterion.id)!.fingerprint })),
    revision: run.revision, cancellationRequested: run.cancelRequested,
    tasks: run.graph.tasks.map(task => ({ id: task.id, kind: task.kind, dependencies: [...task.dependencies], acceptanceCriteria: [...task.acceptanceCriteria], ...(task.inputs ? { inputs: task.inputs } : {}),
      profile: { id: run.execution.tasks.find(entry => entry.taskId === task.id)!.profile.id, version: run.execution.tasks.find(entry => entry.taskId === task.id)!.profile.version },
      phase: progress.get(task.id)!.phase, unresolvedEffects: progress.get(task.id)!.unresolvedEffects,
      ...(progress.get(task.id)!.phase === 'cancelled' ? { cancellation: { reason: run.bindings.find(binding => binding.identity.taskId === task.id)?.observedKind === 'exited' ? 'exited-under-cancellation' : 'prevented-before-launch' } } : {}) })),
  });
}
