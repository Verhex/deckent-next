import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { sameAttemptIdentity, TaskEvaluationError, type AttemptIdentity, type TaskEvaluation } from '#domain/index.js';
import { workerEventLogSchema, criterionEvidenceDigest } from '#engine/index.js';
import { readRunBoundDispatch, readRunBoundTask } from './run-dispatch-lookup.js';
import { SqliteEffectJournal } from './effect.js';
/** Ledger snapshot at park/commit: immutable output and host seal bound to this exact Attempt. */
export function readEvaluationDigests(db: DatabaseSync, identity: AttemptIdentity) {
  const { dispatch } = readRunBoundDispatch(db, identity);
  const row = db.prepare('SELECT record FROM worker_event_logs WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  const log = row ? workerEventLogSchema.parse(JSON.parse(String(row.record))) : null;
  if (log && !sameAttemptIdentity(log.identity, identity)) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  return { output: dispatch?.output?.digest, seal: log?.events.digest, patch: readRunBoundTask(db, identity).workInput ? dispatch?.patch?.digest : undefined };
}
export function assertEvaluationDigests(db: DatabaseSync, evaluation: TaskEvaluation) {
  const current = readEvaluationDigests(db, evaluation.identity);
  const effects = new SqliteEffectJournal(db), { run } = readRunBoundDispatch(db, evaluation.identity);
  const hash = (record: unknown) => createHash('sha256').update(JSON.stringify(record)).digest('hex');
  for (const row of evaluation.criteria) {
    const reference = row.effectEvidence;
    if (!reference) continue;
    const definition = run.graph.criterionDefinitions.find(value => value.id === row.criterionId);
    const selected = run.execution.criteria.find(value => value.criterionId === row.criterionId);
    if (selected?.evaluator.implementation.id !== 'operation-evidence' || selected.evaluator.implementation.version !== 1
      || definition?.parameters.commandId !== reference.commandId) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
    const record = effects.read(evaluation.identity.scopeId, reference.commandId);
    const compensation = record?.state === 'settled' && record.intent.descriptor.compensation
      ? effects.readCompensation(evaluation.identity.scopeId, reference.commandId) : null;
    if (JSON.stringify(reference) !== JSON.stringify({ commandId: reference.commandId, digest: record ? hash(record) : null,
      compensation: compensation ? { commandId: compensation.intent.command.commandId, digest: hash(compensation) } : null })) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  }
  const criterion = criterionEvidenceDigest(evaluation.criteria);
  if (evaluation.evidenceDigests && JSON.stringify(evaluation.evidenceDigests) !== JSON.stringify([current.output, current.seal, current.patch, criterion].filter(Boolean))) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  if (evaluation.workspaceChange && evaluation.workspaceChange.patchDigest !== current.patch) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  const evidence = evaluation.returnEvidence;
  if (evidence && (evidence.digest !== (evidence.kind === 'criterion-evidence' ? criterion : current[evidence.kind === 'output' ? 'output' : evidence.kind === 'workspace-patch' ? 'patch' : 'seal'])
    || (evidence.kind === 'model-seal' && (evaluation.model?.verdict !== 'verified' || evaluation.model.evidence !== 'sealed')))) throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
}
