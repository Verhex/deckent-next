import { persistedInteger, identitySchema, taskProgressSchema, readinessInputSchema, validateTaskGraph, inspectTaskReadiness, excludeConflicting } from '#domain/index.js';
import { z } from 'zod';
import { resourceCapacityInputSchema, selectResourceCapacity, capacityResourceKeySchema, remainingCapacity } from './resource-capacity.js';

const schedulingInputSchema = z.strictObject({
  schemaVersion: z.literal(2),
  capacity: z.strictObject({ executionSlots: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), inFlightSlots: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }),
  /** Complete ordering supplied by scheduling policy, never inferred from task kind or model name. */
  ordering: z.array(identitySchema),
  excludedTaskIds: z.array(identitySchema).optional(),
  /** Trusted, all-scope resource snapshot; absent preserves the existing per-Run contract. */
  resourceCapacity: resourceCapacityInputSchema.optional(),
  snapshot: readinessInputSchema,
});
export class SchedulingError extends Error {
  constructor(readonly code: 'SCHEDULING_INPUT_INVALID' | 'SCHEDULING_ORDER_INVALID') { super(code); this.name = 'SchedulingError'; }
}
/** Deterministic planning only. A durable admission transaction must recheck this snapshot and
 * reserve capacity before dispatch; the plan itself is neither authorization nor a launch receipt.
 * Unknown effects retain capacity unless canonical custody is explicitly released with trusted termination evidence.
 */
export function planSchedulingWave(graphInput: unknown, input: unknown) {
  const graph = validateTaskGraph(graphInput); const parsed = schedulingInputSchema.safeParse(input);
  if (!parsed.success) throw new SchedulingError('SCHEDULING_INPUT_INVALID');
  const { capacity, ordering, snapshot } = parsed.data;
  const graphIds = new Set(graph.tasks.map(task => task.id));
  if (ordering.length !== graphIds.size || new Set(ordering).size !== graphIds.size || ordering.some(id => !graphIds.has(id))) throw new SchedulingError('SCHEDULING_ORDER_INVALID');
  const readiness = inspectTaskReadiness(graph, snapshot);
  const { execution: executionOccupied, inFlight: inFlightOccupied } = measureTaskOccupancy(snapshot.progress);
  const available = Math.max(0, remainingCapacity(capacity, { execution: executionOccupied, inFlight: inFlightOccupied }));
  const ready = new Set(readiness.filter(task => task.disposition === 'ready').map(task => task.taskId));
  const excluded = new Set(parsed.data.excludedTaskIds ?? []);
  if ([...excluded].some(id => !graphIds.has(id))) throw new SchedulingError('SCHEDULING_INPUT_INVALID');
  // D7a: a ready task whose declared resources intersect in-flight work (or an earlier candidate) waits; same exclusion concept.
  const candidates = ordering.filter(id => ready.has(id) && !excluded.has(id)), conflicting = new Set(excludeConflicting(graph, snapshot.progress, candidates));
  const ordered = candidates.filter(id => !conflicting.has(id));
  const resourceWave = selectResourceCapacity(ordered, available, graphIds, parsed.data.resourceCapacity);
  if (!resourceWave) throw new SchedulingError('SCHEDULING_INPUT_INVALID');
  const delayed = new Set(readiness.filter(task => task.disposition === 'delayed').map(task => task.taskId));
  let nextEligibleAt: number | undefined;
  for (const task of snapshot.progress) {
    if (delayed.has(task.taskId) && task.eligibility.kind === 'not-before'
      && (nextEligibleAt === undefined || task.eligibility.at < nextEligibleAt)) nextEligibleAt = task.eligibility.at;
  }
  return Object.freeze({ schemaVersion: 2 as const, graphRevision: graph.revision, observedAt: snapshot.now,
    selectedTaskIds: resourceWave.selected, deferredTaskIds: resourceWave.deferred,
    ...(parsed.data.resourceCapacity ? { resourceWaits: resourceWave.waits } : {}),
    ...(nextEligibleAt === undefined ? {} : { eligibilityGapMs: nextEligibleAt - snapshot.now }),
    occupancy: Object.freeze({ execution: executionOccupied, inFlight: inFlightOccupied }), readiness,
    ...(conflicting.size ? { conflictTaskIds: Object.freeze([...conflicting]) } : {}) });
}

/** Shared occupancy semantics for per-Run plans and durable shared-pool admission. */
export function measureTaskOccupancy(input: unknown) {
  const progress = z.array(taskProgressSchema).parse(input);
  let execution = 0; let inFlight = 0;
  for (const task of progress) {
    if (task.workerCustody?.state === 'released') continue;
    const uncertain = task.unresolvedEffects || task.phase === 'reconciling';
    if (task.phase === 'active' || uncertain) execution++;
    if (task.phase === 'active' || task.phase === 'evaluating' || uncertain) inFlight++;
  }
  return Object.freeze({ execution, inFlight });
}

/** Aggregate authoritative custody across projects/models. Each snapshot is supplied once for its bound resource.
 * Cancellation/crash intent alone does not release uncertain work; the existing custody semantics own release.
 */
export function measureResourceOccupancy(input: unknown) {
  const snapshots = z.array(z.strictObject({ resourceKey: capacityResourceKeySchema, progress: z.array(taskProgressSchema) })).parse(input);
  const result = new Map<string, Readonly<{ execution: number; inFlight: number }>>();
  for (const snapshot of snapshots) {
    const current = result.get(snapshot.resourceKey), occupied = measureTaskOccupancy(snapshot.progress);
    result.set(snapshot.resourceKey, Object.freeze({ execution: counterSum(current?.execution ?? 0, occupied.execution), inFlight: counterSum(current?.inFlight ?? 0, occupied.inFlight) }));
  }
  return result;
}
function counterSum(left: number, right: number) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new SchedulingError('SCHEDULING_INPUT_INVALID');
  return sum;
}
