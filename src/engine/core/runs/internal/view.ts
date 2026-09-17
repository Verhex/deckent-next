import { z } from 'zod';
import { identitySchema, counterSchema, runSnapshotSchema } from '#domain/index.js';
import { RunStoreError } from './store.js';
/** Public query contract. Storage schema changes must be mapped here, never spread into the API. */
export const runViewSchema = z.object({
  schemaVersion: z.literal(1), runId: identitySchema, scopeId: identitySchema, layoutRevision: identitySchema,
  revision: counterSchema, cancellationRequested: z.boolean(),
  tasks: z.array(z.object({
    id: identitySchema, kind: identitySchema, dependencies: z.array(identitySchema).readonly(),
    phase: z.enum(['pending', 'active', 'evaluating', 'accepted', 'failed', 'cancelled', 'reconciling']),
    unresolvedEffects: z.boolean(),
  }).strict().readonly()).readonly(),
}).strict().readonly();
export type RunView = z.infer<typeof runViewSchema>;
export function projectRunView(input: unknown): RunView {
  const parsed = runSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new RunStoreError('RUN_STORE_CORRUPT');
  const run = parsed.data; const progress = new Map(run.progress.map(task => [task.taskId, task]));
  return runViewSchema.parse({ schemaVersion: 1, runId: run.identity.runId, scopeId: run.identity.scopeId,
    layoutRevision: run.identity.layoutRevision, revision: run.revision, cancellationRequested: run.cancelRequested,
    tasks: run.graph.tasks.map(task => ({ id: task.id, kind: task.kind, dependencies: [...task.dependencies],
      phase: progress.get(task.id)!.phase, unresolvedEffects: progress.get(task.id)!.unresolvedEffects })),
  });
}
