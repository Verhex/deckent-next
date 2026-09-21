import { taskEvaluationSchema, sameAttemptIdentity } from '#domain/index.js';
import { verifyEvaluationEvidence, type EvaluationEvidenceLimits, type ArtifactStore } from '#capabilities/index.js';
import { dispatchRecordSchema, verifyRetainedOutputEnvelope, verifyRetainedFileReceipts, type DispatchStore } from '#engine/core/dispatch/index.js';
import { sandboxRequestSchema, sameSandboxRequest } from '#engine/core/supervisor/index.js';
export class TaskEvidenceError extends Error {
  constructor(readonly code: 'TASK_EVIDENCE_INVALID' | 'TASK_EVIDENCE_UNAVAILABLE' | 'TASK_EVIDENCE_UNLINKED') { super(code); this.name = 'TaskEvidenceError'; }
}
/** Internal read-only evidence step after admission. The record comes from the trusted ledger, never
 * from evaluator input. Only retained dispatch output is currently supported; arbitrary task artifacts
 * need a separate durable producer link. This does not authorize or commit Task acceptance.
 */
export async function verifyDispatchEvaluationEvidence(evaluationInput: unknown, requestInput: unknown, manifest: unknown,
  dispatches: Pick<DispatchStore, 'readDispatch'>, artifacts: Pick<ArtifactStore, 'read'>, limits: EvaluationEvidenceLimits) {
  const evaluation = taskEvaluationSchema.safeParse(evaluationInput); const request = sandboxRequestSchema.safeParse(requestInput);
  if (!evaluation.success || !request.success) throw new TaskEvidenceError('TASK_EVIDENCE_INVALID');
  if (!sameAttemptIdentity(evaluation.data.identity, request.data.identity)) throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED');
  let input;
  try { input = await dispatches.readDispatch(request.data); }
  catch { throw new TaskEvidenceError('TASK_EVIDENCE_UNAVAILABLE'); }
  const record = dispatchRecordSchema.safeParse(input);
  if (!record.success || !record.data.terminal || !sameSandboxRequest(record.data.request, request.data)) throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED');
  const receipt = record.data.output;
  // The capability verifier checks exact reference coverage and all scope/budget limits first.
  // Guard every content read against the immutable receipt loaded from the execution ledger.
  let unlinked = false; let retainedBytes: Uint8Array | undefined;
  try {
    const verified = await verifyEvaluationEvidence(evaluation.data, manifest, {
      async read(scopeId, supplied) {
        if (!receipt || receipt.schemaVersion !== supplied.schemaVersion || receipt.scopeId !== supplied.scopeId
          || receipt.digest !== supplied.digest || receipt.byteLength !== supplied.byteLength) {
          unlinked = true; throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED');
        }
        return retainedBytes ??= await artifacts.read(scopeId, supplied);
      },
    }, limits);
    if (retainedBytes) {
      try { await verifyRetainedFileReceipts(artifacts, verifyRetainedOutputEnvelope(retainedBytes, record.data.request.identity)); }
      catch { unlinked = true; throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED'); }
    }
    return verified;
  } catch (error) {
    if (unlinked) throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED');
    throw error;
  }
}
