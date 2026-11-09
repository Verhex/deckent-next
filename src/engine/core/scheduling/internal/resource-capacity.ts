import { counterSchema, identitySchema } from '#domain/index.js';
import { z } from 'zod';

/** Random metadata identity assigned by the trusted connection owner; never a token, model, scope or login path. */
export const capacityResourceKeySchema = z.uuid().toLowerCase();
const slots = z.strictObject({ executionSlots: counterSchema, inFlightSlots: counterSchema }).readonly();
const occupancy = z.strictObject({ execution: counterSchema, inFlight: counterSchema }).readonly();
export const resourceCapacityInputSchema = z.strictObject({
  bindings: z.array(z.strictObject({ taskId: identitySchema, resourceKey: capacityResourceKeySchema }).readonly()).readonly(),
  resources: z.array(z.strictObject({ resourceKey: capacityResourceKeySchema, capacity: slots, occupancy }).readonly()).readonly(),
}).readonly();
export type ResourceCapacityInput = z.infer<typeof resourceCapacityInputSchema>;
export interface ResourceCapacityWait {
  readonly taskId: string;
  readonly resourceKey: string;
  readonly code: 'waiting-resource-slot';
  readonly capacity: ResourceCapacityInput['resources'][number]['capacity'];
  readonly occupancy: ResourceCapacityInput['resources'][number]['occupancy'];
}
type Counts = Readonly<{ execution: number; inFlight: number }>;
/** KG10 F3: the one room rule. Below zero is over capacity; a pool's dispatch gate reads that deficit, so it is never clamped here. */
export const remainingCapacity = (capacity: Readonly<{ executionSlots: number; inFlightSlots: number }>, occupancy: Counts) => Math.min(capacity.executionSlots - occupancy.execution, capacity.inFlightSlots - occupancy.inFlight);
export const hasCapacityRoom = (capacity: Parameters<typeof remainingCapacity>[0], occupancy: Counts) => remainingCapacity(capacity, occupancy) > 0;

/** Pure dimension of the existing wave, not a reservation. The admission transaction must supply all-scope
 * occupancy and recheck/reserve it atomically. Login serialization remains a separate enforced safety bound.
 */
export function selectResourceCapacity(candidates: readonly string[], available: number, graphIds: ReadonlySet<string>, input?: ResourceCapacityInput) {
  const resources = new Map(input?.resources.map(resource => [resource.resourceKey, { ...resource, execution: resource.occupancy.execution, inFlight: resource.occupancy.inFlight }]));
  const bindings = new Map(input?.bindings.map(binding => [binding.taskId, binding.resourceKey]));
  if (resources.size !== (input?.resources.length ?? 0) || bindings.size !== (input?.bindings.length ?? 0)
    || input?.bindings.some(binding => !graphIds.has(binding.taskId) || !resources.has(binding.resourceKey))) return null;
  const selected: string[] = [], deferred: string[] = [], waits: ResourceCapacityWait[] = [];
  for (const taskId of candidates) {
    const key = bindings.get(taskId), resource = key === undefined ? undefined : resources.get(key);
    if (resource && !hasCapacityRoom(resource.capacity, resource)) {
      deferred.push(taskId);
      waits.push(Object.freeze({ taskId, resourceKey: resource.resourceKey, code: 'waiting-resource-slot', capacity: resource.capacity,
        occupancy: Object.freeze({ execution: resource.execution, inFlight: resource.inFlight }) }));
    } else if (selected.length < available) {
      selected.push(taskId);
      if (resource) { resource.execution++; resource.inFlight++; }
    } else deferred.push(taskId);
  }
  return { selected: Object.freeze(selected), deferred: Object.freeze(deferred), waits: Object.freeze(waits) };
}
