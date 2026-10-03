import { z } from 'zod';
import { attemptIdentitySchema, sameAttemptIdentity, taskDependencyIds, type RunSnapshot } from '#domain/index.js';
import type { HandoffStartRecord } from './receipt.js';
/** One engine projection shared by Run/Task inspection and monitor; a dependency alone never proves delivery. */
export const handoffReceiptViewSchema = z.object({ source: attemptIdentitySchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();
export type HandoffReceiptView = z.infer<typeof handoffReceiptViewSchema>;
export function projectTaskHandoffs(run: RunSnapshot, taskId: string, records: readonly HandoffStartRecord[]): readonly HandoffReceiptView[] {
  const task = run.graph.tasks.find(value => value.id === taskId), binding = run.bindings.find(value => value.identity.taskId === taskId);
  if (!task || !binding) return Object.freeze([]);
  const dependencies = taskDependencyIds(task), receipts = new Map<string, HandoffReceiptView>();
  for (const record of records) {
    if (!sameAttemptIdentity(record.identity, binding.identity)) continue;
    for (const event of record.events) {
      if (event.kind !== 'handoff-received' || !dependencies.includes(event.source.taskId)) continue;
      const source = run.bindings.find(value => value.identity.taskId === event.source.taskId);
      if (!source || !sameAttemptIdentity(source.identity, event.source) || run.progress.find(value => value.taskId === event.source.taskId)?.phase !== 'accepted') continue;
      receipts.set(event.source.taskId, handoffReceiptViewSchema.parse({ source: event.source, digest: event.digest }));
    }
  }
  return Object.freeze([...receipts.values()]);
}
