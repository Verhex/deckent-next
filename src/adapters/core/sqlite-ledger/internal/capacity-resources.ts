import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/index.js';
import { capacityResourceKeySchema, measureTaskOccupancy, RunStoreError } from '#engine/index.js';
import { ledgerTransaction } from './options.js';
import { decodeLedgerRunSnapshot } from './run-snapshot.js';
const bindingSchema = z.strictObject({ kind: identitySchema, id: z.string().min(1).max(8192) });
const capacitySchema = z.strictObject({ executionSlots: counterSchema.positive(), inFlightSlots: counterSchema.positive() });
export type CapacityResourceBinding = z.infer<typeof bindingSchema>;
export function readCapacityResource(db: DatabaseSync, key: string) {
  const resourceKey = capacityResourceKeySchema.parse(key), row = db.prepare('SELECT * FROM capacity_resources WHERE resource_key=?').get(resourceKey);
  try {
    if (!row || row.resource_key !== resourceKey) throw new Error();
    bindingSchema.parse({ kind: row.binding_kind, id: row.binding_id });
    return { resourceKey, capacity: capacitySchema.parse({ executionSlots: row.execution_slots, inFlightSlots: row.in_flight_slots }) };
  } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
}
export function findCapacityResource(db: DatabaseSync, input: CapacityResourceBinding) {
  const binding = bindingSchema.parse(input), row = db.prepare('SELECT resource_key FROM capacity_resources WHERE binding_kind=? AND binding_id=?').get(binding.kind, binding.id);
  return row ? readCapacityResource(db, String(row.resource_key)) : null;
}
/** Called by the connection writer or legacy first-use admission, once per real resource. A UUID is persisted, never derived from its locator.
 * Changed capacity requires an admitted revision mechanism; reconnect cannot silently increase or decrease it. */
export function bindCapacityResource(db: DatabaseSync, input: CapacityResourceBinding, capacityInput: z.infer<typeof capacitySchema>) {
  const binding = bindingSchema.parse(input), capacity = capacitySchema.parse(capacityInput);
  const bind = () => {
    const prior = findCapacityResource(db, binding);
    if (prior) {
      if (prior.capacity.executionSlots !== capacity.executionSlots || prior.capacity.inFlightSlots !== capacity.inFlightSlots) throw new RunStoreError('RUN_POOL_CONFLICT');
      return prior;
    }
    const resourceKey = randomUUID();
    db.prepare('INSERT INTO capacity_resources(resource_key,binding_kind,binding_id,execution_slots,in_flight_slots) VALUES(?,?,?,?,?)')
      .run(resourceKey, binding.kind, binding.id, capacity.executionSlots, capacity.inFlightSlots);
    return readCapacityResource(db, resourceKey);
  };
  return ledgerTransaction(db, bind, { join: true });
}
/** KG10 F3: the one occupancy reader. Existing receipts and Run progress own active custody; no second counter, expiry or restart-reset lease.
 * Each bound Run is decoded once. `heldLogin` verifies a claimed invocation row and names the login it holds (null: none). */
export function readCapacityOccupancy(db: DatabaseSync, resourceKey: string, heldLogin: (row: Readonly<Record<string, unknown>>) => CapacityResourceBinding | null) {
  let execution = 0, inFlight = 0;
  const runs = new Map<string, { row: Readonly<Record<string, unknown>>; taskIds: unknown[] }>();
  for (const row of db.prepare(`SELECT b.scope_id,b.run_id,b.task_id,r.revision,r.snapshot FROM run_capacity_resources b
    JOIN runs r ON r.scope_id=b.scope_id AND r.run_id=b.run_id WHERE b.resource_key=?`).all(resourceKey)) {
    const id = JSON.stringify([row.scope_id, row.run_id]), bound = runs.get(id);
    if (bound) bound.taskIds.push(row.task_id); else runs.set(id, { row, taskIds: [row.task_id] });
  }
  for (const { row, taskIds } of runs.values()) {
    const run = decodeLedgerRunSnapshot(row.snapshot, String(row.scope_id), String(row.run_id), undefined, value => value.revision === row.revision);
    const progress = taskIds.map(taskId => run.progress.find(task => task.taskId === taskId));
    if (progress.some(task => !task)) throw new RunStoreError('RUN_STORE_CORRUPT');
    const occupied = measureTaskOccupancy(progress); execution += occupied.execution; inFlight += occupied.inFlight;
  }
  const resource = db.prepare('SELECT binding_kind,binding_id FROM capacity_resources WHERE resource_key=?').get(resourceKey);
  for (const row of db.prepare("SELECT scope_id,invocation_id,record FROM model_invocations WHERE state='claimed'").all()) {
    const held = heldLogin(row);
    if (resource && held && held.kind === resource.binding_kind && held.id === resource.binding_id) { execution++; inFlight++; }
  }
  if (!Number.isSafeInteger(execution) || !Number.isSafeInteger(inFlight)) throw new RunStoreError('RUN_STORE_CORRUPT');
  return { execution, inFlight };
}
