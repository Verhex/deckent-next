import type { DatabaseSync } from 'node:sqlite';
import { NATIVE_CLI_HEADLESS_ADAPTER_ID, type ModelInvocationProfile, type RunSnapshot } from '#domain/index.js';
import { nativeCliHeadlessDefinitionSchema } from '#capabilities/index.js';
import { decodeLedgerRunSnapshot, findCapacityResource, readCapacityResource } from '#adapters/core/sqlite-ledger/index.js';
import { ModelInvocationStoreError, verifyModelInvocationReceipt, measureTaskOccupancy, RunStoreError } from '#engine/index.js';
/** Private metadata locator only; no credential bytes, account inference or model identity. */
export function headlessCapacityBinding(input: unknown) {
  const definition = nativeCliHeadlessDefinitionSchema.parse(input);
  return { kind: NATIVE_CLI_HEADLESS_ADAPTER_ID, id: JSON.stringify([definition.ownerUid, definition.configDir]) };
}
export function invocationCapacityResource(db: DatabaseSync, profile: ModelInvocationProfile) {
  if (profile.adapter.id !== NATIVE_CLI_HEADLESS_ADAPTER_ID) return null;
  const resource = findCapacityResource(db, headlessCapacityBinding(profile.adapter.definition));
  if (!resource) throw new ModelInvocationStoreError('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
  return resource;
}
/** Existing receipts and Run progress own active custody. No second counter, expiry or restart-reset lease. */
export function readCapacityResourceOccupancy(db: DatabaseSync, resourceKey: string) {
  let execution = 0, inFlight = 0;
  const rows = db.prepare(`SELECT b.scope_id,b.run_id,b.task_id,r.revision,r.snapshot FROM run_capacity_resources b
    JOIN runs r ON r.scope_id=b.scope_id AND r.run_id=b.run_id WHERE b.resource_key=?`).all(resourceKey);
  for (const row of rows) {
    const run = decodeLedgerRunSnapshot(row.snapshot, String(row.scope_id), String(row.run_id));
    const task = run.progress.find(task => task.taskId === row.task_id);
    if (!task || run.identity.scopeId !== row.scope_id || run.identity.runId !== row.run_id || run.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
    const occupied = measureTaskOccupancy([task]); execution += occupied.execution; inFlight += occupied.inFlight;
  }
  for (const row of db.prepare("SELECT scope_id,invocation_id,record FROM model_invocations WHERE state='claimed'").all()) {
    const receipt = verifyModelInvocationReceipt(JSON.parse(String(row.record)));
    if (receipt.claim.scopeId !== row.scope_id || receipt.claim.invocationId !== row.invocation_id || receipt.outcome !== null) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    const resource = invocationCapacityResource(db, receipt.profile);
    if (resource?.resourceKey === resourceKey) { execution++; inFlight++; }
  }
  if (!Number.isSafeInteger(execution) || !Number.isSafeInteger(inFlight)) throw new RunStoreError('RUN_STORE_CORRUPT');
  return { execution, inFlight };
}
export function assertInvocationResourceCapacity(db: DatabaseSync, profile: ModelInvocationProfile) {
  const resource = invocationCapacityResource(db, profile);
  if (!resource) return;
  const occupancy = readCapacityResourceOccupancy(db, resource.resourceKey);
  if (occupancy.execution >= resource.capacity.executionSlots || occupancy.inFlight >= resource.capacity.inFlightSlots) throw new ModelInvocationStoreError('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
}
export function readRunCapacityBindings(db: DatabaseSync, run: RunSnapshot) {
  const bindings = db.prepare('SELECT task_id,resource_key FROM run_capacity_resources WHERE scope_id=? AND run_id=? ORDER BY task_id')
    .all(run.identity.scopeId, run.identity.runId).map(row => ({ taskId: String(row.task_id), resourceKey: String(row.resource_key) }));
  return bindings;
}
export function readRunResourceCapacity(db: DatabaseSync, run: RunSnapshot) {
  const bindings = readRunCapacityBindings(db, run);
  const resources = [...new Set(bindings.map(row => row.resourceKey))].map(key => ({ ...readCapacityResource(db, key), occupancy: readCapacityResourceOccupancy(db, key) }));
  return { bindings, resources };
}
