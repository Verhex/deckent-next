import { bindTaskAcceptance, taskEvaluationSchema, type OperationEvidenceBinding, type RunSnapshot, type TaskEvaluation } from '#domain/index.js';

/** The ledger checks use by another Run under its acceptance transaction; this pure normalization owns no I/O or transition. */
export function bindUsedOperationEvidence(run: RunSnapshot, evaluation: TaskEvaluation, isUsed: (commandId: string) => boolean): TaskEvaluation {
  const criteria = evaluation.criteria.map(row => (row.verdict === 'pass' || (row.verdict === 'unknown' && row.reason === 'OPERATION_EVIDENCE_EARLIER')) && row.effectEvidence && isUsed(row.effectEvidence.commandId)
    ? { ...row, verdict: 'fail' as const, reason: 'OPERATION_EVIDENCE_OTHER_RUN' as const, evidenceTypes: [], evidenceReferences: [] } : row);
  return criteria.every((row, index) => row === evaluation.criteria[index]) ? evaluation : taskEvaluationSchema.parse(bindTaskAcceptance(run, { ...evaluation, criteria }));
}
type Actor = OperationEvidenceBinding['principals'][number];
/** The grant is the earliest admissible settlement. Wall-clock tolerance cannot prove causal ownership:
 * without trusted provenance or an exact already accepted same-Run settlement, a pre-grant effect remains unknown. */
export function operationEvidenceBinding(grant: Readonly<{ grantedAt: number; principal: Actor }> | undefined, runPrincipal: Actor | null | undefined, acceptedSettlements?: OperationEvidenceBinding['acceptedSettlements']): OperationEvidenceBinding | undefined {
  return grant ? { notBefore: grant.grantedAt, principals: [grant.principal, ...(runPrincipal ? [runPrincipal] : [])], ...(acceptedSettlements?.length ? { acceptedSettlements } : {}) } : undefined;
}
