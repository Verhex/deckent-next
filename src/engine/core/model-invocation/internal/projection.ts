import { createImmutableJsonObjectSchema, MODEL_INVOCATION_RECEIPT_JSON_LIMITS, modelInvocationReceiptViewSchema,
  type ModelInvocationReceipt, type ModelInvocationReceiptView, type ModelInvocationResponseEvidence } from '#domain/index.js';
import { verifyModelInvocationReceipt } from './evidence.js';
import { ModelInvocationStoreError } from './port.js';

const envelope = createImmutableJsonObjectSchema(MODEL_INVOCATION_RECEIPT_JSON_LIMITS);
export function summarizeModelInvocationResponse(evidence: ModelInvocationResponseEvidence) {
  const { encoding, byteLength, observedBytes, complete, digest } = evidence.body;
  const body = { encoding, byteLength, observedBytes, complete, digest };
  return Object.freeze({ ...evidence, body: Object.freeze(body) });
}
/** Call only after verifying the durable receipt. Never replaces the private stored evidence. */
export function projectModelInvocationReceipt(receipt: ModelInvocationReceipt): ModelInvocationReceiptView {
  const outcome = receipt.outcome;
  if (!outcome || outcome.state === 'responded' || outcome.evidence === null) return receipt;
  return Object.freeze({ ...receipt, outcome: Object.freeze({ ...outcome, evidence: summarizeModelInvocationResponse(outcome.evidence) }) });
}
/** Metadata digests identify retained bytes; without those bytes this parser cannot independently verify their hash. */
export function verifyModelInvocationReceiptView(input: unknown): ModelInvocationReceiptView {
  try {
    const copied = envelope.parse(input), view = modelInvocationReceiptViewSchema.parse(copied);
    const outcome = view.outcome;
    // Reuse the canonical static identity/profile checks without inventing an evidence body or digest.
    verifyModelInvocationReceipt({ ...view, outcome: outcome?.state === 'responded' ? outcome : null });
    if (outcome && outcome.state !== 'responded' && outcome.evidence) {
      const evidence = outcome.evidence;
      if (evidence.adapter.id !== view.profile.adapter.id || evidence.adapter.version !== view.profile.adapter.version
        || evidence.body.byteLength > view.profile.limits.responseMaxBytes) throw new Error('EVIDENCE');
    }
    return view;
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
