import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identitySchema, taskEvaluationSchema } from '#domain/index.js';
import { artifactReceiptSchema, ArtifactError, type ArtifactStore } from '#capabilities/core/artifacts/index.js';
const itemSchema = z.object({ evidenceId: identitySchema, receipt: artifactReceiptSchema }).strict().readonly();
const limitsSchema = z.object({ maxEvidenceItems: z.number().int().positive().safe(), maxTotalBytes: z.number().int().positive().safe() }).strict();
export type EvaluationEvidenceLimits = z.infer<typeof limitsSchema>;
export class EvaluationEvidenceError extends Error {
  constructor(readonly code: 'EVALUATION_EVIDENCE_INVALID' | 'EVALUATION_EVIDENCE_INCOMPLETE' | 'EVALUATION_EVIDENCE_SCOPE'
    | 'EVALUATION_EVIDENCE_LIMIT' | 'EVALUATION_EVIDENCE_CORRUPT' | 'EVALUATION_EVIDENCE_UNAVAILABLE') { super(code); this.name = 'EvaluationEvidenceError'; }
}
/** Content/reference validation only. Caller must authenticate, authorize and bind producer/attempt provenance.
 * Limits are explicit policy input; no filesystem path or implicit storage adapter is selected here.
 */
export async function verifyEvaluationEvidence(evaluationInput: unknown, manifestInput: unknown, store: Pick<ArtifactStore, 'read'>, limitsInput: EvaluationEvidenceLimits) {
  const limits = limitsSchema.safeParse(limitsInput); const evaluation = taskEvaluationSchema.safeParse(evaluationInput);
  if (!limits.success || !evaluation.success || !Array.isArray(manifestInput)) throw new EvaluationEvidenceError('EVALUATION_EVIDENCE_INVALID');
  if (manifestInput.length > limits.data.maxEvidenceItems) throw new EvaluationEvidenceError('EVALUATION_EVIDENCE_LIMIT');
  const manifest = z.array(itemSchema).safeParse(manifestInput);
  if (!manifest.success) throw new EvaluationEvidenceError('EVALUATION_EVIDENCE_INVALID');
  const needed = new Set(evaluation.data.criteria.flatMap(value => value.evidenceIds));
  const found = new Set(manifest.data.map(value => value.evidenceId));
  if (found.size !== manifest.data.length || found.size !== needed.size || [...needed].some(id => !found.has(id))) throw new EvaluationEvidenceError('EVALUATION_EVIDENCE_INCOMPLETE');
  let remaining = limits.data.maxTotalBytes;
  for (const item of manifest.data) {
    if (item.receipt.scopeId !== evaluation.data.identity.scopeId) throw new EvaluationEvidenceError('EVALUATION_EVIDENCE_SCOPE');
    if (item.receipt.byteLength > remaining) throw new EvaluationEvidenceError('EVALUATION_EVIDENCE_LIMIT');
    remaining -= item.receipt.byteLength;
  }
  // Validate the complete manifest before any adapter read. Sequential reads bound in-flight work.
  for (const item of manifest.data) {
    let bytes: Uint8Array;
    try { bytes = await store.read(evaluation.data.identity.scopeId, item.receipt); }
    catch (error) {
      throw new EvaluationEvidenceError(error instanceof ArtifactError && error.code === 'ARTIFACT_CORRUPT' ? 'EVALUATION_EVIDENCE_CORRUPT' : 'EVALUATION_EVIDENCE_UNAVAILABLE');
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== item.receipt.byteLength
      || createHash('sha256').update(bytes).digest('hex') !== item.receipt.digest) throw new EvaluationEvidenceError('EVALUATION_EVIDENCE_CORRUPT');
  }
  return Object.freeze([...manifest.data].sort((a, b) => a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0));
}
