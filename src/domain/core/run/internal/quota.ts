import { attemptSnapshotSchema, type AttemptSnapshot } from '#domain/core/attempt/index.js';
import { readWorkerModelPin } from '#domain/core/worker-event/index.js';
import { checkedRun, runSnapshotSchema, RunError, type RunSnapshot } from './contract.js';
import { heldRunState, readRunHold } from './hold.js';
export type RunQuotaWait = NonNullable<RunSnapshot['quotaWaits']>[number];
/** Host-proven exit classification, not a worker grant. Application verifies artifacts and model evidence first. */
export function parkRunQuota(input: unknown, expectedRevision: number, attempt: AttemptSnapshot, wait: RunQuotaWait) {
  const run = checkedRun(input, expectedRevision), task = run.progress.find(row => row.taskId === attempt.identity.taskId);
  const binding = run.bindings.find(row => row.identity.attemptId === attempt.identity.attemptId);
  const pin = readWorkerModelPin(run.execution.tasks.find(row => row.taskId === attempt.identity.taskId)?.profile.parameters);
  if (run.cancelRequested || attempt.cancelRequested || task?.unresolvedEffects || task?.phase !== 'evaluating' || binding?.observedKind !== 'exited'
    || binding.observedRevision !== attempt.revision || attempt.lastObservation?.result.kind !== 'exited' || !pin || pin.pin.channelId !== wait.channelId
    || JSON.stringify(wait.identity) !== JSON.stringify(attempt.identity) || wait.deadline <= wait.since) throw new RunError('RUN_ATTEMPT_CONFLICT');
  const result = attempt.lastObservation.result;
  const classified = attemptSnapshotSchema.parse({ ...attempt, revision: attempt.revision + 1, lastObservation: { ...attempt.lastObservation,
    sequence: attempt.lastObservation.sequence + 1, eventId: 'quota-exhausted', result: { ...result, kind: 'quota-exhausted', quota: wait.quota, evidenceDigest: wait.evidenceDigest, ...(wait.resetBoundExceeded ? { resetBoundExceeded: true } : {}) } } });
  const snapshot = runSnapshotSchema.parse({ ...run, revision: run.revision + 1, quotaWaits: [...(run.quotaWaits ?? []), wait],
    state: run.state.kind === 'parked' && run.state.reason === 'operator-hold' ? run.state : { kind: 'parked', reason: 'quota-exhausted', ...(run.state.kind === 'parked' && run.state.operatorHold ? { operatorHold: run.state.operatorHold } : {}), since: wait.since, deadline: Math.max(wait.deadline, run.state.kind === 'parked' && run.state.reason === 'quota-exhausted' ? run.state.deadline : 0) },
    progress: run.progress.map(row => row === task ? { ...row, phase: 'pending' } : row),
    bindings: run.bindings.map(row => row === binding ? { ...row, observedKind: 'quota-exhausted', observedRevision: classified.revision } : row) });
  return { snapshot, attempt: classified };
}
/** Time alone is not reset evidence. Unknown reset remains parked and uses ordinary bounded expiry. */
export function resetRunQuota(run: RunSnapshot, now: number): RunSnapshot | null {
  const held = run.bindings.filter(row => row.observedKind === 'quota-exhausted');
  if (!held.length || run.cancelRequested || run.state.kind !== 'parked' || run.state.reason !== 'quota-exhausted' || run.state.operatorHold) return null;
  const waits = held.map(row => run.quotaWaits?.find(wait => wait.identity.attemptId === row.identity.attemptId));
  if (waits.some(wait => !wait || wait.quota.source !== 'claude-rate-limit' || wait.resetBoundExceeded || wait.quota.resetsAtMs === null || wait.quota.resetsAtMs <= wait.since || wait.deadline > now
    || (run.quotaWaits ?? []).filter(prior => prior.identity.taskId === wait.identity.taskId).length > wait.maxResumes)) return null;
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1, state: { kind: 'running' },
    bindings: run.bindings.filter(row => !held.includes(row)), previousBindings: [...(run.previousBindings ?? []), ...held] });
}

/** Explicit installation operator release; retained quota evidence/reset timestamps never change. */
export function releaseRunQuota(run: RunSnapshot, channelId: string, now: number): RunSnapshot | null {
  const selected = (run.quotaWaits ?? []).filter(wait => wait.channelId === channelId && wait.deadline > now && wait.releasedAtMs === undefined);
  if (!selected.length) return null;
  const ids = new Set(selected.map(wait => wait.identity.attemptId));
  const held = run.bindings.filter(row => ids.has(row.identity.attemptId) && run.progress.some(task => task.taskId === row.identity.taskId && task.phase === 'pending'));
  const movable = !run.cancelRequested && run.state.kind !== 'terminal';
  const resume = !run.cancelRequested && run.state.kind === 'parked' && run.state.reason === 'quota-exhausted';
  const remaining = (run.quotaWaits ?? []).filter(wait => !ids.has(wait.identity.attemptId) && run.bindings.some(row => row.identity.attemptId === wait.identity.attemptId));
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1,
    quotaWaits: run.quotaWaits!.map(wait => ids.has(wait.identity.attemptId) ? { ...wait, releasedAtMs: now } : wait),
    ...(movable ? { bindings: run.bindings.filter(row => !held.includes(row)), previousBindings: [...(run.previousBindings ?? []), ...held] } : {}),
    ...(resume ? { state: remaining.length ? { kind: 'parked', reason: 'quota-exhausted', ...(run.state.kind === 'parked' && run.state.operatorHold ? { operatorHold: run.state.operatorHold } : {}), since: Math.min(...remaining.map(wait => wait.since)), deadline: Math.max(...remaining.map(wait => wait.deadline)) } : run.state.kind === 'parked' && run.state.operatorHold ? heldRunState(readRunHold(run.state)!, run.state.since, run.state.deadline) : { kind: 'running' } } : {}) });
}
