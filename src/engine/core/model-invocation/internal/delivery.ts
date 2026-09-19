import type { ModelInvocationReceipt } from '#domain/index.js';
import { ModelInvocationStoreError } from './port.js';

/** Internal caller capacity, never a permission or a persisted invocation field. */
export interface ModelInvocationDelivery { readonly maxResultBytes: number }
const bytes = (value: unknown): bigint => BigInt(Buffer.byteLength(JSON.stringify(value), 'utf8'));
export function validateInvocationDelivery(delivery?: ModelInvocationDelivery): void {
  if (delivery && (!Number.isSafeInteger(delivery.maxResultBytes) || delivery.maxResultBytes <= 0)) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_DELIVERY_UNAVAILABLE');
  }
}
export function assertInvocationDeliveryFit(receipt: ModelInvocationReceipt, responseBytes: bigint | undefined,
  delivery: ModelInvocationDelivery): void {
  if (typeof responseBytes !== 'bigint' || responseBytes <= 0n) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_DELIVERY_UNAVAILABLE');
  }
  // false is longer than true. null is a placeholder only; native-response bytes include its complete wrapper.
  const responded = bytes({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 1,
    state: 'responded', response: null, observedAtMs: Number.MAX_SAFE_INTEGER } } }) - bytes(null) + responseBytes;
  const unknown = bytes({ replayed: false, receipt: { ...receipt, outcome: { schemaVersion: 1,
    state: 'unknown', reason: 'transport-error', observedAtMs: Number.MAX_SAFE_INTEGER } } });
  if (responded > BigInt(delivery.maxResultBytes) || unknown > BigInt(delivery.maxResultBytes)) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_RESULT_LIMIT');
  }
}
export function checkInvocationResultDelivery<T>(result: T, delivery?: ModelInvocationDelivery): T {
  if (delivery && bytes(result) > BigInt(delivery.maxResultBytes)) throw new ModelInvocationStoreError('MODEL_INVOCATION_RESULT_LIMIT');
  return result;
}
