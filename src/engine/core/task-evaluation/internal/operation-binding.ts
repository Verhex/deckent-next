import { bindTaskAcceptance, taskEvaluationSchema, type RunSnapshot, type TaskEvaluation } from '#domain/index.js';

/** The ledger supplies the lookup under its acceptance transaction; this pure normalization owns no I/O or transition. */
export function bindUsedOperationEvidence(run: RunSnapshot, evaluation: TaskEvaluation, isUsed: (commandId: string) => boolean): TaskEvaluation {
  const criteria = evaluation.criteria.map(row => row.verdict === 'pass' && row.effectEvidence && isUsed(row.effectEvidence.commandId)
    ? { ...row, verdict: 'fail' as const, reason: 'OPERATION_EVIDENCE_REUSED' as const, evidenceTypes: [], evidenceReferences: [] } : row);
  return criteria.every((row, index) => row === evaluation.criteria[index]) ? evaluation : taskEvaluationSchema.parse(bindTaskAcceptance(run, { ...evaluation, criteria }));
}
