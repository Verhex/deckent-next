import { parseModelAllocation, type ModelAllocation } from './checkpoint.js';

/**
 * A concurrency slot counts a call whose local request may still be open: only a claim without an outcome (INFLIGHT-FIX, lead card
 * 2026-09-28, replacing PROVIDERS/A3A). Every settlement, `unknown` included, is written after the native send settled, when its HTTP
 * request is already closed; the uncertain record, its spending hold and the lifetime count stay.
 */
export interface ModelAllocationSlotRelease {
  readonly allocations: number;
  readonly released: number;
  /** Open calls of an ended owner settled `unknown` (FIX-2143-SLOTS); each freed its own slot, counted here, not in `released`. */
  readonly settled: number;
  /** Allocations whose records do not verify, or whose counter no rule explains (below the open claims, or above open + settled unknown
   * calls): reported and left exactly as they are (Astra 2143 R1). */
  readonly inconsistent: readonly { readonly scopeId: string; readonly allocationId: string }[];
}
/** What only the holder of endpoint custody can assert at start: which send owners have ended, and the settlement time. */
export interface ModelAllocationStartCustody {
  readonly atMs: number;
  endedOwner(ownerId: string): boolean;
}
export interface ModelAllocationSlotReleaseStore {
  /** Start reconciliation under endpoint custody, from records verified in the same transaction: settles the open calls of ended owners
   * `unknown` and frees slots an earlier build kept for settled `unknown` calls. Never writes to an allocation that does not verify. */
  releaseSettledSlots(custody: ModelAllocationStartCustody): Promise<ModelAllocationSlotRelease>;
}
/**
 * Pure plan for one allocation from its retained invocation states. An earlier build kept a slot for each settled `unknown` call, so
 * `open < inFlight <= open + unknown` is the only surplus it can explain; that surplus is released and nothing else is changed.
 */
export function planModelAllocationSlotRelease(allocationInput: ModelAllocation, states: { readonly open: number; readonly unknown: number }):
  { readonly kind: 'consistent' } | { readonly kind: 'inconsistent' } | { readonly kind: 'release'; readonly released: number; readonly next: ModelAllocation } {
  const allocation = parseModelAllocation(allocationInput), { open, unknown } = states;
  if (!Number.isSafeInteger(open) || !Number.isSafeInteger(unknown) || open < 0 || unknown < 0) return { kind: 'inconsistent' };
  if (allocation.inFlight === open) return { kind: 'consistent' };
  if (allocation.inFlight < open || allocation.inFlight > open + unknown) return { kind: 'inconsistent' };
  return { kind: 'release', released: allocation.inFlight - open, next: parseModelAllocation({ ...allocation, inFlight: open }) };
}
