import type { RunView } from '#engine/index.js';
import type { RunControlAction } from './workline-ledger.js';

/** Display only; the service rechecks state and policy at the confirmed revision. */
export function runControlActions(run: RunView): readonly RunControlAction[] {
  if (run.state.kind === 'terminal' || run.cancellationRequested) return [];
  if (run.state.kind !== 'parked') return ['hold'];
  const held = run.state.reason === 'operator-hold' || run.state.operatorHold !== undefined;
  return [...(held ? [] : ['hold' as const]), ...(held || run.state.reason === 'progression-failed' || run.state.reason === 'environment-not-ready' ? ['resume' as const] : []), 'close'];
}
