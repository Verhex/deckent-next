import { modelInvocationResponseEvidenceUpperBound } from './response-evidence.js';
import { IDENTITY_MAX_LENGTH, MODEL_INVOCATION_NATIVE_JSON_LIMITS, MODEL_INVOCATION_RECEIPT_JSON_LIMITS,
  identitySchema, type ModelInvocationReceipt } from '#domain/index.js';
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
  const descriptor = { schemaVersion: 1, kind: 'response-body', encoding: 'base64', digest: 'f'.repeat(64),
    byteLength: Number.MAX_SAFE_INTEGER };
  const maximum = bytes({ ...receipt, outcome: { schemaVersion: 4, state: 'unknown', reason: 'transport-error', evidence: {
    schemaVersion: 1, adapter: receipt.profile.adapter, reason: 'response-limit', httpStatus: null,
    body: { encoding: 'base64', byteLength: Number.MAX_SAFE_INTEGER, observedBytes: Number.MAX_SAFE_INTEGER,
      complete: false, digest: 'f'.repeat(64) } }, content: descriptor, observedAtMs: Number.MAX_SAFE_INTEGER } });
  // Serialized UTF-8 bytes conservatively bound the parser's code-unit budget, including all fixed receipt fields.
  if (evidenceBytes > BigInt(MODEL_INVOCATION_NATIVE_JSON_LIMITS.maxCodeUnits)
    || maximum > BigInt(MODEL_INVOCATION_RECEIPT_JSON_LIMITS.maxCodeUnits)) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_RESULT_LIMIT');
  }
}
/**
 * Worst-case serialized bytes of a native adapter's `{schemaVersion,native,usage}` response envelope at a given raw
 * response cap: `usage` cannot be proven smaller than `native`, so both are bounded by the same cap. Both shipped
 * openai-chat-completions adapters delegate here instead of duplicating the formula (SESSION-RESULT-LIMIT-2026-09-28);
 * a profile-level fitness check (doctor, activation) reuses it directly, without a live prepared native request.
 */
export function modelInvocationNativeResponseUpperBound(responseMaxBytes: number): bigint {
  const cap = BigInt(responseMaxBytes);
  const wrapper = BigInt(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, native: null, usage: null }), 'utf8'));
  return wrapper - 8n + cap + (cap > 4n ? cap : 4n);
}
/** The largest of the five worst-case outcome shapes a delivery must fit; extracted so a read-only profile check
 * (doctor, activation) can report the exact required byte count, reusing the same computation as the throwing gate. */
function requiredDeliveryBytes(receipt: ModelInvocationReceipt, responseBytes: bigint): bigint {
  // false is longer than true. null is a placeholder only; native-response bytes include its complete wrapper.
  const nativeDescriptor = { schemaVersion: 1, kind: 'native-response', encoding: 'canonical-json', digest: 'f'.repeat(64),
    byteLength: Number.MAX_SAFE_INTEGER };
  const responded = bytes({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 4,
    state: 'responded', content: nativeDescriptor, observedAtMs: Number.MAX_SAFE_INTEGER } }, response: null,
    contentStatus: 'retained', purge: null }) - bytes(null) + responseBytes;
  const unknown = bytes({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 4,
    state: 'unknown', reason: 'transport-error', evidence: null, content: null, observedAtMs: Number.MAX_SAFE_INTEGER } },
    response: null, contentStatus: 'not-captured', purge: null });
  // Lone UTF-16 surrogates are accepted identity code units and JSON escapes each as six ASCII bytes.
  const maximumCancellationCommandId = identitySchema.parse(String.fromCharCode(0xd800).repeat(IDENTITY_MAX_LENGTH));
  const notSent = bytes({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 4,
    state: 'not-sent', reason: 'cancelled-before-permission', cancellationCommandId: maximumCancellationCommandId,
    observedAtMs: Number.MAX_SAFE_INTEGER, content: null } }, response: null, contentStatus: 'not-captured', purge: null });
  const responseBodyDescriptor = { ...nativeDescriptor, kind: 'response-body', encoding: 'base64' };
  const summary = { schemaVersion: 1, adapter: receipt.profile.adapter, reason: 'response-limit', httpStatus: null,
    body: { encoding: 'base64', byteLength: Number.MAX_SAFE_INTEGER, observedBytes: Number.MAX_SAFE_INTEGER,
      complete: false, digest: 'f'.repeat(64) } };
  const rejected = bytes({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 4,
    state: 'rejected', evidence: { ...summary, reason: 'invalid-response', body: { ...summary.body, complete: true } },
    content: responseBodyDescriptor, observedAtMs: Number.MAX_SAFE_INTEGER } }, response: null, contentStatus: 'retained', purge: null });
  const partial = bytes({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 4,
    state: 'unknown', reason: 'transport-error', evidence: summary, content: responseBodyDescriptor,
    observedAtMs: Number.MAX_SAFE_INTEGER } }, response: null, contentStatus: 'retained', purge: null });
  let max = rejected;
  if (partial > max) max = partial;
  if (responded > max) max = responded;
  if (unknown > max) max = unknown;
  if (notSent > max) max = notSent;
  return max;
}
export function assertInvocationDeliveryFit(receipt: ModelInvocationReceipt, responseBytes: bigint | undefined,
  delivery: ModelInvocationDelivery): void {
  if (typeof responseBytes !== 'bigint' || responseBytes <= 0n) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_DELIVERY_UNAVAILABLE');
  }
  if (requiredDeliveryBytes(receipt, responseBytes) > BigInt(delivery.maxResultBytes)) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_RESULT_LIMIT');
  }
}
/**
 * Read-only prediction of `assertInvocationDeliveryFit`'s exact required byte count for a receipt that has not
 * (and may never have) been claimed — a profile-level check (doctor, activation) reuses this instead of copying
 * the math (SESSION-RESULT-LIMIT-2026-09-28). `responseBytes` must already be positive and finite (the caller
 * proves this the same way `invoke()` does, via `modelInvocationNativeResponseUpperBound`).
 */
export function modelInvocationProfileDeliveryRequirement(receipt: ModelInvocationReceipt, responseBytes: bigint): bigint {
  return requiredDeliveryBytes(receipt, responseBytes);
}
/** Non-throwing form of `assertInvocationDeliveryFit`, for a caller that keeps checking other profiles/surfaces. */
export function modelInvocationDeliveryFits(receipt: ModelInvocationReceipt, responseBytes: bigint,
  delivery: ModelInvocationDelivery): boolean {
  try { assertInvocationDeliveryFit(receipt, responseBytes, delivery); return true; }
  catch (error) {
    if (error instanceof ModelInvocationStoreError && error.code === 'MODEL_INVOCATION_RESULT_LIMIT') return false;
    throw error;
  }
}
export function checkInvocationResultDelivery<T>(result: T, delivery?: ModelInvocationDelivery): T {
  if (delivery && bytes(result) > BigInt(delivery.maxResultBytes)) throw new ModelInvocationStoreError('MODEL_INVOCATION_RESULT_LIMIT');
  return result;
}
/**
 * Divides a raw MCP tool-result wire budget into safe content bytes once the caller's own envelope overhead
 * (JSON-RPC + tool-result wrapper, protocol-specific — the caller measures it, this stays free of any SDK type)
 * is subtracted: escaped/duplicated JSON content costs at most 3x its raw bytes (quoting doubles the worst case,
 * plus one duplicate copy in `structuredContent`). The MCP surface's own `boundedToolDelivery` and a static
 * profile check below the surfaces layer (composition doctor/activation, via the mcp-transport adapter) both
 * delegate here so the arithmetic itself is never duplicated (SESSION-RESULT-LIMIT-2026-09-28 review).
 */
export function mcpToolResultDeliveryCapacity(maximum: number, envelopeOverheadBytes: bigint): ModelInvocationDelivery | null {
  const available = (BigInt(maximum) - envelopeOverheadBytes) / 3n;
  if (available <= 0n) return null;
  return Object.freeze({ maxResultBytes: Number(available) });
}
