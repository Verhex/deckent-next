import { parseModelAllocation, type ModelAllocation } from './checkpoint.js';

/**
 * A concurrency slot counts a call whose local request may still be open: only a claim without an outcome (INFLIGHT-FIX, lead card
 * 2026-09-28, replacing PROVIDERS/A3A). Every settlement, `unknown` included, is written after the native send settled, when its HTTP
 * request is already closed; the uncertain record, its spending hold and the lifetime count stay.
 */
export interface ModelAllocationSlotRelease {
  readonly allocations: number;
  readonly released: number;
  /** Counters no rule explains (below the open claims, or above open + settled unknown calls): reported, never rewritten. */
  readonly inconsistent: readonly { readonly scopeId: string; readonly allocationId: string }[];
}
export interface ModelAllocationSlotReleaseStore {
  /** Start reconciliation under endpoint custody: frees slots an earlier build kept for settled `unknown` calls. */
  releaseSettledSlots(): Promise<ModelAllocationSlotRelease>;
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
