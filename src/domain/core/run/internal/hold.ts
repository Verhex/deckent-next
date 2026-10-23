import type { RunHoldSource, RunSnapshot } from './contract.js';
type ParkedState = Extract<RunSnapshot['state'], { kind: 'parked' }>;
export type RunHold = Readonly<{ note: string; source: RunHoldSource }>;
/** S5b: the one reader of a Run's hold, as its own park (`operator-hold`) or as an overlay on another park. */
export function readRunHold(state: RunSnapshot['state']): RunHold | null {
  if (state.kind !== 'parked') return null;
  if (state.reason === 'operator-hold') return { note: state.note!, source: state.holdSource ?? 'operator' };
  return state.operatorHold ? { note: state.operatorHold.note, source: state.operatorHold.source ?? 'operator' } : null;
}
/** The overlay a hold keeps on another park; the operator source is not written (earlier releases read it unchanged). */
export const runHoldOverlay = (hold: RunHold) => ({ operatorHold: { schemaVersion: 1 as const, note: hold.note, ...(hold.source === 'operator' ? {} : { source: hold.source }) } });
/** The Run's own hold park, carrying the source through every overlay round trip (quota release, answer, park resolution). */
export const heldRunState = (hold: RunHold, since: number, deadline: number): ParkedState => ({ kind: 'parked', reason: 'operator-hold', note: hold.note,
  ...(hold.source === 'operator' ? {} : { holdSource: hold.source }), since, deadline });
