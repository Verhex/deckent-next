import type { DatabaseSync } from 'node:sqlite';
import { runCapacityBindingsSchema, RunStoreError, type RunCreate, type RunReceipt, type RunCapacityBinding } from '#engine/index.js';
import { readCapacityResource } from './capacity-resources.js';
/** Called inside the Run writer's transaction; replay cannot change or omit its original resource metadata. */
export function withRunCapacityBindings(db: DatabaseSync, input: RunCreate, resources: readonly RunCapacityBinding[], create: () => RunReceipt): RunReceipt {
  const bindings = runCapacityBindingsSchema.parse(resources), { scopeId, runId } = input.identity;
  if (new Set(bindings.map(row => row.taskId)).size !== bindings.length || bindings.some(row => !input.graph.tasks.some(task => task.id === row.taskId))) throw new RunStoreError('RUN_COMMAND_CONFLICT');
  const replay = db.prepare('SELECT 1 FROM run_receipts WHERE scope_id=? AND command_id=?').get(scopeId, input.commandId);
  const receipt = create();
  if (replay) {
    const stored = db.prepare('SELECT task_id,resource_key FROM run_capacity_resources WHERE scope_id=? AND run_id=? ORDER BY task_id')
      .all(scopeId, runId).map(row => ({ taskId: String(row.task_id), resourceKey: String(row.resource_key) }));
    const ordered = [...bindings].sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
    if (JSON.stringify(stored) !== JSON.stringify(ordered)) throw new RunStoreError('RUN_COMMAND_CONFLICT');
  } else for (const binding of bindings) {
    readCapacityResource(db, binding.resourceKey);
    db.prepare('INSERT INTO run_capacity_resources(scope_id,run_id,task_id,resource_key) VALUES(?,?,?,?)').run(scopeId, runId, binding.taskId, binding.resourceKey);
  }
  return receipt;
}
