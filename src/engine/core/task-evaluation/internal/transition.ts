import { applyTaskEvaluation, attemptSnapshotSchema, runSnapshotSchema, sameAttemptIdentity, taskEvaluationSchema, TaskEvaluationError } from '#domain/index.js';
import { dispatchRecordSchema } from '#engine/core/dispatch/index.js';
import { assertRunExecution } from '#engine/core/runs/index.js';

function invalid(): never { throw new TaskEvaluationError('TASK_EVALUATION_INVALID'); }
function stale(): never { throw new TaskEvaluationError('TASK_EVALUATION_STALE'); }
function notReady(): never { throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY'); }

/** Pure ledger decision. It verifies stored custody but grants no evaluator or artifact authority. */
export function proposeTaskEvaluationCommit(runInput: unknown, attemptInput: unknown, dispatchInput: unknown, expectedRunRevision: number, evaluationInput: unknown) {
  let run; let attempt; let dispatch; let evaluation;
  try {
    run = runSnapshotSchema.parse(runInput); attempt = attemptSnapshotSchema.parse(attemptInput);
    dispatch = dispatchRecordSchema.parse(dispatchInput); evaluation = taskEvaluationSchema.parse(evaluationInput);
    assertRunExecution(run.graph, run.execution);
  } catch { invalid(); }
  if (!Number.isSafeInteger(expectedRunRevision) || expectedRunRevision < 0 || run.revision !== expectedRunRevision) stale();
  const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, evaluation.identity));
  if (!binding || !sameAttemptIdentity(attempt.identity, evaluation.identity) || !sameAttemptIdentity(dispatch.request.identity, evaluation.identity)) stale();
  if (attempt.revision !== evaluation.attemptRevision || binding.observedRevision !== evaluation.attemptRevision) stale();
  if (attempt.cancelRequested || run.cancelRequested || binding.observedKind !== 'exited' || attempt.lastObservation?.result.kind !== 'exited') notReady();
  if (dispatch.launch !== 'granted' || !dispatch.terminal || !dispatch.output || dispatch.terminal.interrupted === true) notReady();
  const observed = attempt.lastObservation.result;
  if (dispatch.terminal.exitCode !== observed.exitCode || dispatch.terminal.signal !== observed.signal) stale();
  const result = applyTaskEvaluation(run, expectedRunRevision, evaluation);
  return Object.freeze({ ...result, output: dispatch.output });
}
