import { sameAttemptIdentity, type AttemptIdentity } from '#domain/core/attempt/index.js';
import type { RunSnapshot } from './contract.js';

/** EXEC-RELEASE C2: what an attempt's clone still owes before its custody (stopped container, Git clone) may be released.
 * - `patch-required`: a workspace delivery may be owed, so only a retained, verified patch releases it. Fail-closed default: every task
 *   whose kind carries no explicit `workspaceDelivery: 'none'` declaration in the Run's frozen execution snapshot, and every task with
 *   typed work input, whatever its kind (owner 2026-10-06 B: absence of work input never implies "nothing to deliver").
 * - `not-required`: the kind is declared to deliver nothing from its workspace (its output envelope is retained by dispatch) and the
 *   task has settled, so no evaluation, operator decision or reconciliation can still read the clone.
 * - `not-settled`: declared without workspace delivery, but the task is still evaluating, awaiting a decision, reconciling or active.
 * - `unbound`: the Run does not bind this exact attempt (never released on this basis). */
export type WorkspaceDeliveryState = 'patch-required' | 'not-required' | 'not-settled' | 'unbound';
const SETTLED_PHASES: ReadonlySet<string> = new Set(['accepted', 'failed', 'cancelled', 'skipped']);

/** Pure: reads only the Run snapshot frozen at admission and its recorded progress; never a live resource. */
export function workspaceDeliveryState(run: RunSnapshot, identity: AttemptIdentity): WorkspaceDeliveryState {
  const task = run.graph.tasks.find(value => value.id === identity.taskId);
  const progress = run.progress.find(value => value.taskId === identity.taskId);
  if (!task || !progress || run.identity.scopeId !== identity.scopeId || run.identity.runId !== identity.runId
    || !run.bindings.some(binding => sameAttemptIdentity(binding.identity, identity))) return 'unbound';
  const declared = run.execution.tasks.find(value => value.taskId === identity.taskId)?.workspaceDelivery === 'none';
  if (task.workInput || !declared) return 'patch-required';
  return SETTLED_PHASES.has(progress.phase) && !progress.unresolvedEffects ? 'not-required' : 'not-settled';
}
