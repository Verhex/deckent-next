import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/index.js';
import { capacityResourceKeySchema, RunStoreError } from '#engine/index.js';
import { ledgerTransaction } from './options.js';
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
  return db.isTransaction ? bind() : ledgerTransaction(db, bind);
}
