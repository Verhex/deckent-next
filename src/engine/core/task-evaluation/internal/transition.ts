import { parkRunQuota, recoverStalledTask, applyTaskEvaluation, attemptSnapshotSchema, readWorkerModelPin, runSnapshotSchema, sameAttemptIdentity, taskEvaluationSchema, TaskEvaluationError, type AttemptIdentity } from '#domain/index.js';
import { dispatchRecordSchema } from '#engine/core/dispatch/index.js';
import { assertRunExecution } from '#engine/core/runs/index.js';

function invalid(): never { throw new TaskEvaluationError('TASK_EVALUATION_INVALID'); }
function stale(): never { throw new TaskEvaluationError('TASK_EVALUATION_STALE'); }
function notReady(): never { throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY'); }

/** Fresh exact-attempt custody and lifecycle guards, before any installed criterion reader. */
/** `stall`: the caller may read a host-watchdog stop (`interruptCause: 'inactivity'`), only to retry or fail it; every other interruption is refused. */
export function assertTaskEvaluationReady(runInput: unknown, attemptInput: unknown, dispatchInput: unknown, expectedRunRevision: number,
  identity: AttemptIdentity, now: number, stall = false) {
  let run; let attempt; let dispatch;
  try {
    run = runSnapshotSchema.parse(runInput); attempt = attemptSnapshotSchema.parse(attemptInput);
    dispatch = dispatchRecordSchema.parse(dispatchInput); assertRunExecution(run.graph, run.execution);
  } catch { invalid(); }
  if (!Number.isSafeInteger(expectedRunRevision) || expectedRunRevision < 0 || run.revision !== expectedRunRevision) stale();
  const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, identity));
  if (!binding || !sameAttemptIdentity(attempt.identity, identity) || !sameAttemptIdentity(dispatch.request.identity, identity)
    || attempt.revision !== binding.observedRevision) stale();
  const progress = run.progress.find(value => value.taskId === identity.taskId);
  if (attempt.cancelRequested || run.cancelRequested || binding.observedKind !== 'exited' || attempt.lastObservation?.result.kind !== 'exited'
    || run.state.kind === 'terminal' || !progress || progress.unresolvedEffects
    || !['evaluating', 'awaiting-decision'].includes(progress.phase) || progress.decision?.reason === 'needs-input'
    || (progress.decision && (progress.decision.deadline <= now || (run.state.kind === 'parked' && run.state.deadline <= now)))) notReady();
  if (dispatch.launch !== 'granted' || !dispatch.terminal || !dispatch.output || (dispatch.terminal.interrupted === true && !(stall && dispatch.terminal.interruptCause === 'inactivity'))) notReady();
  const observed = attempt.lastObservation.result;
  if (dispatch.terminal.exitCode !== observed.exitCode || dispatch.terminal.signal !== observed.signal) stale();
  return { run, attempt, dispatch };
}
/** Pure ledger decision. It verifies stored custody but grants no evaluator or artifact authority. */
export function proposeTaskEvaluationCommit(runInput: unknown, attemptInput: unknown, dispatchInput: unknown, expectedRunRevision: number, evaluationInput: unknown, timing: { now: number; timeoutMs: number; unknownDisposition?: 'fail' }) {
  let evaluation;
  try { evaluation = taskEvaluationSchema.parse(evaluationInput); } catch { invalid(); }
  const stall = evaluation.stall;
  const { run, attempt, dispatch } = assertTaskEvaluationReady(runInput, attemptInput, dispatchInput, expectedRunRevision, evaluation.identity, timing.now, stall?.cause === 'inactivity');
  // R3: a silence stall is exactly a watchdog-stopped terminal; a report stall is a clean, uninterrupted exit. Neither can ever become a pass.
  if (stall && ((dispatch.terminal!.interrupted === true) !== (stall.cause === 'inactivity'))) invalid();
  // WORKER-CURRENCY-2: a Run whose frozen profile pins a worker model is evaluated only with that attempt's model evidence (and never
  // with evidence for another pin); a task without a pin never carries it. The ledger commit re-runs this check.
  const pinned = readWorkerModelPin(run.execution.tasks.find(entry => entry.taskId === evaluation.identity.taskId)?.profile.parameters);
  if (!pinned !== !evaluation.model || (pinned && (pinned.provider !== evaluation.model!.provider || pinned.evidenceCapability !== evaluation.model!.evidenceCapability
    || JSON.stringify(pinned.pin) !== JSON.stringify(evaluation.model!.requested)))) invalid();
  if (attempt.revision !== evaluation.attemptRevision) stale();
  if ((evaluation.workerExit || evaluation.report) && dispatch.terminal!.exitCode !== 0) notReady();
  if (evaluation.workspaceChange && evaluation.workspaceChange.patchDigest !== dispatch.patch?.digest) stale();
  if (evaluation.quota) {
    if (!pinned || pinned.pin.channelId !== evaluation.quota.channelId || evaluation.model?.verdict === 'substituted' || evaluation.workerExit || dispatch.terminal!.exitCode === 0 || dispatch.terminal!.interrupted !== false
      || !evaluation.evidenceDigests?.includes(evaluation.quota.evidenceDigest)) notReady();
    const { signal, channelId, evidenceDigest, maxResumes } = evaluation.quota;
    // S9 (owner L-A): the wait is at most the configured bound; a reset beyond it asks a person at once, an unknown one when the bound ends.
    const bound = evaluation.quota.maxWaitMs ?? timing.timeoutMs;
    const resetBoundExceeded = signal.resetsAtMs !== null && signal.resetsAtMs - timing.now > bound;
    const deadline = signal.resetsAtMs !== null && signal.resetsAtMs > timing.now && !resetBoundExceeded ? signal.resetsAtMs : timing.now + bound;
    const proposed = parkRunQuota(run, expectedRunRevision, attempt, { identity: evaluation.identity, channelId, quota: signal, evidenceDigest, since: timing.now, deadline, maxResumes, ...(resetBoundExceeded ? { resetBoundExceeded: true } : {}) });
    return Object.freeze({ ...proposed, evaluation, conclusion: 'unknown' as const, output: dispatch.output });
  }
  const result = applyTaskEvaluation(run, expectedRunRevision, evaluation, timing);
  if (stall) {
    const recovered = recoverStalledTask(run, expectedRunRevision, evaluation.identity, stall.cause, { now: timing.now, backoffMs: stall.backoffMs, timeoutMs: timing.timeoutMs });
    return Object.freeze({ evaluation: result.evaluation, snapshot: recovered.snapshot, conclusion: recovered.outcome === 'retry' ? 'unknown' as const : 'fail' as const, attempt: undefined, output: dispatch.output });
  }
  return Object.freeze({ ...result, attempt: undefined, output: dispatch.output });
}
