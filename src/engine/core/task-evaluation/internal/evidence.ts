import { beuserDigest, beuserEvidenceSchema, beuserParametersSchema, type BeuserEvidence } from '#capabilities/index.js';
import { createHash } from 'node:crypto';
import { hasSecret } from '#platform/index.js';
import type { DispatchRecord } from '#engine/core/dispatch/index.js';
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
      try {
        const output = verifyRetainedOutputEnvelope(retainedBytes, record.data.request.identity);
        const totalBytes = (receipt?.byteLength ?? 0) + (output.files ?? []).reduce((sum, file) => sum + (file.status === 'collected' ? file.receipt.byteLength : 0), 0);
        if (totalBytes > limits.maxTotalBytes || (output.files?.length ?? 0) + verified.length > limits.maxEvidenceItems) throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED');
        await verifyRetainedFileReceipts(artifacts, output);
      }
      catch { unlinked = true; throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED'); }
    }
    return verified;
  } catch (error) {
    if (unlinked) throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED');
    throw error;
  }
}

/** Dispatch and criterion come from the authenticated evaluation owner. Never accepts a caller-supplied artifact link. */
export async function readBeuserDispatchEvidence(dispatch: DispatchRecord, parameters: unknown, artifacts: Pick<ArtifactStore, 'read'>,
  limits: EvaluationEvidenceLimits): Promise<BeuserEvidence | null> {
  const pinned = beuserParametersSchema.parse(parameters), scopeId = dispatch.request.identity.scopeId;
  if (beuserDigest(pinned.binding.identity) !== beuserDigest(dispatch.request.identity) || dispatch.owner !== pinned.producer.owner
    || beuserDigest(dispatch.profile) !== pinned.producer.profileDigest || dispatch.launch !== 'granted' || !dispatch.terminal || !dispatch.output) {
    throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED');
  }
  let remaining = limits.maxTotalBytes;
  const read = async (receipt: NonNullable<DispatchRecord['output']>) => {
    if (receipt.scopeId !== scopeId || receipt.byteLength > remaining) throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED');
    remaining -= receipt.byteLength;
    const bytes = await artifacts.read(scopeId, receipt);
    if (bytes.byteLength !== receipt.byteLength || createHash('sha256').update(bytes).digest('hex') !== receipt.digest) throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED');
    return bytes;
  };
  const envelope = verifyRetainedOutputEnvelope(await read(dispatch.output), dispatch.request.identity);
  if ((envelope.files?.length ?? 0) + 1 > limits.maxEvidenceItems) throw new TaskEvidenceError('TASK_EVIDENCE_UNLINKED');
  const file = envelope.files?.find(f => f.name === pinned.fileName);
  if (!file || file.status !== 'collected') return null;
  const bytes = await read(file.receipt);
  let data;
  try { data = beuserEvidenceSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { return null; }
  if (!data.success || hasSecret(JSON.stringify(data.data))) return null;
  // An interrupted process can retain partial observations but cannot prove the complete lifecycle.
  return dispatch.terminal.interrupted === false ? data.data : null;
}
