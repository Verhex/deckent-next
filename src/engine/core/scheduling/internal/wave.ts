import { z } from 'zod';
import { identitySchema, taskProgressSchema, readinessInputSchema, validateTaskGraph, inspectTaskReadiness } from '#domain/index.js';
const schedulingInputSchema = z.object({
  schemaVersion: z.literal(1),
  capacity: z.object({ executionSlots: z.number().int().nonnegative().safe(), inFlightSlots: z.number().int().nonnegative().safe() }).strict(),
  /** Complete ordering supplied by scheduling policy, never inferred from task kind or model name. */
  ordering: z.array(identitySchema),
  snapshot: readinessInputSchema,
}).strict();
export class SchedulingError extends Error {
  constructor(readonly code: 'SCHEDULING_INPUT_INVALID' | 'SCHEDULING_ORDER_INVALID') { super(code); this.name = 'SchedulingError'; }
}
/** Deterministic planning only. A durable admission transaction must recheck this snapshot and
 * reserve capacity before dispatch; the plan itself is neither authorization nor a launch receipt.
 * Unknown effects retain capacity until reconciliation, even when a worker appears to have exited.
 */
export function planSchedulingWave(graphInput: unknown, input: unknown) {
  const graph = validateTaskGraph(graphInput); const parsed = schedulingInputSchema.safeParse(input);
  if (!parsed.success) throw new SchedulingError('SCHEDULING_INPUT_INVALID');
  const { capacity, ordering, snapshot } = parsed.data;
  const graphIds = new Set(graph.tasks.map(task => task.id));
  if (ordering.length !== graphIds.size || new Set(ordering).size !== graphIds.size || ordering.some(id => !graphIds.has(id))) throw new SchedulingError('SCHEDULING_ORDER_INVALID');
  const readiness = inspectTaskReadiness(graph, snapshot);
  const { execution: executionOccupied, inFlight: inFlightOccupied } = measureTaskOccupancy(snapshot.progress);
  const available = Math.min(Math.max(0, capacity.executionSlots - executionOccupied), Math.max(0, capacity.inFlightSlots - inFlightOccupied));
  const ready = new Set(readiness.filter(task => task.disposition === 'ready').map(task => task.taskId));
  const ordered = ordering.filter(id => ready.has(id));
  const delayed = new Set(readiness.filter(task => task.disposition === 'delayed').map(task => task.taskId));
  let nextEligibleAt: number | undefined;
  for (const task of snapshot.progress) {
    if (delayed.has(task.taskId) && (nextEligibleAt === undefined || task.eligibleAt < nextEligibleAt)) nextEligibleAt = task.eligibleAt;
  }
  return Object.freeze({ schemaVersion: 1 as const, graphRevision: graph.revision, observedAt: snapshot.now,
    selectedTaskIds: Object.freeze(ordered.slice(0, available)), deferredTaskIds: Object.freeze(ordered.slice(available)),
    ...(nextEligibleAt === undefined ? {} : { eligibilityGapMs: nextEligibleAt - snapshot.now }),
    occupancy: Object.freeze({ execution: executionOccupied, inFlight: inFlightOccupied }), readiness });
}

/** Shared occupancy semantics for per-Run plans and durable shared-pool admission. */
export function measureTaskOccupancy(input: unknown) {
  const progress = z.array(taskProgressSchema).parse(input);
  let execution = 0; let inFlight = 0;
  for (const task of progress) {
    const uncertain = task.unresolvedEffects || task.phase === 'reconciling';
    if (task.phase === 'active' || uncertain) execution++;
    if (task.phase === 'active' || task.phase === 'evaluating' || uncertain) inFlight++;
  }
  return Object.freeze({ execution, inFlight });
}
