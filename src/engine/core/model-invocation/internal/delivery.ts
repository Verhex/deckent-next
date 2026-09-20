import { modelInvocationResponseEvidenceUpperBound } from './response-evidence.js';
import { MODEL_INVOCATION_NATIVE_JSON_LIMITS, MODEL_INVOCATION_RECEIPT_JSON_LIMITS, type ModelInvocationReceipt } from '#domain/index.js';
import { ModelInvocationStoreError } from './port.js';

/** Internal caller capacity, never a permission or a persisted invocation field. */
export interface ModelInvocationDelivery { readonly maxResultBytes: number }
const bytes = (value: unknown): bigint => BigInt(Buffer.byteLength(JSON.stringify(value), 'utf8'));
export function validateInvocationDelivery(delivery?: ModelInvocationDelivery): void {
  if (delivery && (!Number.isSafeInteger(delivery.maxResultBytes) || delivery.maxResultBytes <= 0)) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_DELIVERY_UNAVAILABLE');
  }
}
/** Prove that a maximum retained rejection fits the canonical receipt parser, independently of the caller's transport. */
export function assertInvocationEvidenceStorageFit(receipt: ModelInvocationReceipt): void {
  const evidenceBytes = modelInvocationResponseEvidenceUpperBound(receipt.profile);
  const maximum = bytes({ ...receipt, outcome: { schemaVersion: 2, state: 'unknown', reason: 'transport-error',
    evidence: null, observedAtMs: Number.MAX_SAFE_INTEGER } }) - bytes(null) + evidenceBytes;
  // Serialized UTF-8 bytes conservatively bound the parser's code-unit budget, including all fixed receipt fields.
  if (evidenceBytes > BigInt(MODEL_INVOCATION_NATIVE_JSON_LIMITS.maxCodeUnits)
    || maximum > BigInt(MODEL_INVOCATION_RECEIPT_JSON_LIMITS.maxCodeUnits)) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_RESULT_LIMIT');
  }
}
export function assertInvocationDeliveryFit(receipt: ModelInvocationReceipt, responseBytes: bigint | undefined,
  delivery: ModelInvocationDelivery): void {
  if (typeof responseBytes !== 'bigint' || responseBytes <= 0n) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_DELIVERY_UNAVAILABLE');
  }
  // false is longer than true. null is a placeholder only; native-response bytes include its complete wrapper.
  const responded = bytes({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 2,
    state: 'responded', response: null, observedAtMs: Number.MAX_SAFE_INTEGER } } }) - bytes(null) + responseBytes;
  const unknown = bytes({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 2,
    state: 'unknown', reason: 'transport-error', evidence: null, observedAtMs: Number.MAX_SAFE_INTEGER } } });
  const evidenceBytes = modelInvocationResponseEvidenceUpperBound(receipt.profile);
  const rejected = bytes({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 2,
    state: 'rejected', evidence: null, observedAtMs: Number.MAX_SAFE_INTEGER } } }) - bytes(null) + evidenceBytes;
  const partial = unknown - bytes(null) + evidenceBytes;
  if (rejected > BigInt(delivery.maxResultBytes) || partial > BigInt(delivery.maxResultBytes) || responded > BigInt(delivery.maxResultBytes) || unknown > BigInt(delivery.maxResultBytes)) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_RESULT_LIMIT');
  }
}
export function checkInvocationResultDelivery<T>(result: T, delivery?: ModelInvocationDelivery): T {
  if (delivery && bytes(result) > BigInt(delivery.maxResultBytes)) throw new ModelInvocationStoreError('MODEL_INVOCATION_RESULT_LIMIT');
  return result;
}
