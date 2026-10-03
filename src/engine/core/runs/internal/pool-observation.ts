import { z } from 'zod';
import { counterSchema, identitySchema, inspectTaskReadiness, type RunSnapshot } from '#domain/index.js';
import { measureTaskOccupancy } from '#engine/core/scheduling/index.js';
import { poolOccupancySchema, type PoolHoldRecord } from './pool-hold.js';
const capacity = z.object({ executionSlots: counterSchema, inFlightSlots: counterSchema }).strict().readonly();
export const poolWaitSchema = z.object({ code: z.enum(['waiting-pool-slot', 'pool-held']), poolId: identitySchema,
  capacity, effectiveCapacity: capacity, occupancy: poolOccupancySchema, sinceMs: counterSchema.nullable() }).strict().readonly();
export const poolDriftSchema = z.object({ code: z.literal('POOL_ADMISSION_CAPACITY_DRIFT'), poolId: identitySchema,
  source: z.enum(['admission', 'run']), requested: capacity, capacity }).strict().readonly();
export const runPoolObservationSchema = z.object({ poolId: identitySchema, capacity, effectiveCapacity: capacity, occupancy: poolOccupancySchema,
  drift: z.array(poolDriftSchema).readonly(), waiting: z.array(z.object({ taskId: identitySchema, reason: poolWaitSchema }).strict().readonly()).readonly() }).strict().readonly();
export type PoolWait = z.infer<typeof poolWaitSchema>;
export type PoolDrift = z.infer<typeof poolDriftSchema>;
export interface RunPoolEvidence { readonly snapshot: RunSnapshot | null; readonly pool: { readonly poolId: string; readonly capacity: z.infer<typeof capacity>;
  readonly runCapacity: z.infer<typeof capacity>; readonly occupancy: z.infer<typeof poolOccupancySchema>; readonly hold: PoolHoldRecord | null; readonly admitted: boolean } | null }
export const poolCapacityDrift = (poolId: string, requested: z.infer<typeof capacity>, current: z.infer<typeof capacity>, source: PoolDrift['source']): PoolDrift | null =>
  requested.executionSlots > current.executionSlots || requested.inFlightSlots > current.inFlightSlots
    ? poolDriftSchema.parse({ code: 'POOL_ADMISSION_CAPACITY_DRIFT', poolId, source, requested: { executionSlots: requested.executionSlots, inFlightSlots: requested.inFlightSlots }, capacity: current }) : null;
/** Current snapshot evidence, never a historical refused-at time. No writes and no extra control-path work. */
export function derivePoolWait(poolId: string, current: z.infer<typeof capacity>, effective: z.infer<typeof capacity>, occupancy: z.infer<typeof poolOccupancySchema>,
  hold: { readonly state: 'held' | 'open'; readonly changedAtMs: number } | null): PoolWait | null {
  const code = hold?.state === 'held' ? 'pool-held' : occupancy.execution >= effective.executionSlots || occupancy.inFlight >= effective.inFlightSlots ? 'waiting-pool-slot' : null;
  return code ? poolWaitSchema.parse({ code, poolId, capacity: current, effectiveCapacity: effective, occupancy, sinceMs: code === 'pool-held' ? hold!.changedAtMs : null }) : null;
}
export function hasRunReservationRoom(snapshot: RunSnapshot, limit: { readonly executionSlots: number; readonly inFlightSlots: number }): boolean {
  const own = measureTaskOccupancy(snapshot.progress);
  return own.execution < limit.executionSlots && own.inFlight < limit.inFlightSlots;
}
export function observeRunPool(e: RunPoolEvidence, now: number, admission?: z.infer<typeof capacity> & { readonly poolId: string }, ceiling = Infinity) {
  const { snapshot, pool } = e; if (!snapshot || !pool) return undefined;
  const effectiveCapacity = { executionSlots: Math.min(pool.capacity.executionSlots, ceiling), inFlightSlots: Math.min(pool.capacity.inFlightSlots, ceiling) };
  const drift = [poolCapacityDrift(pool.poolId, pool.runCapacity, pool.capacity, 'run'), ...(admission?.poolId === pool.poolId ? [poolCapacityDrift(pool.poolId, admission, pool.capacity, 'admission')] : [])].filter((value): value is PoolDrift => !!value);
  const reason = derivePoolWait(pool.poolId, pool.capacity, effectiveCapacity, pool.occupancy, pool.hold);
  const eligible = snapshot.state.kind === 'running' && !snapshot.cancelRequested && pool.admitted
    && hasRunReservationRoom(snapshot, pool.runCapacity);
  const waiting = eligible && reason ? inspectTaskReadiness(snapshot.graph, { graphRevision: snapshot.graph.revision, now, progress: snapshot.progress })
    .filter(task => task.disposition === 'ready').map(task => ({ taskId: task.taskId, reason })) : [];
  return runPoolObservationSchema.parse({ poolId: pool.poolId, capacity: pool.capacity, effectiveCapacity, occupancy: pool.occupancy, drift, waiting });
}
