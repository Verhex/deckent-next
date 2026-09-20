import { SERVER_INFO_META_KEY, type CallToolResult, type RequestId } from '@modelcontextprotocol/server';
import { PACKAGE_NAME, PACKAGE_VERSION } from '#platform/index.js';
import { ModelInvocationStoreError, type ModelInvocationDelivery, type RuntimeServiceDelivery } from '#engine/index.js';

/** Author fields that the pinned SDK would otherwise add after tools/call returns.
 * tools/call is not cacheable. Both supported codec eras preserve these authored fields. */
export function completeToolResult(result: CallToolResult): CallToolResult {
  return { ...result, resultType: 'complete', _meta: { [SERVER_INFO_META_KEY]: { name: PACKAGE_NAME, version: PACKAGE_VERSION } } };
}
function wireBytes(id: RequestId, result: CallToolResult): bigint {
  return BigInt(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n', 'utf8'));
}
export function toolResultFits(id: RequestId, result: CallToolResult, maximum: number): boolean {
  return wireBytes(id, result) <= BigInt(maximum);
}
export function modelToolDelivery(id: RequestId, maximum: number): ModelInvocationDelivery {
  const delivery = boundedToolDelivery(id, maximum);
  if (!delivery) throw new ModelInvocationStoreError('MODEL_INVOCATION_RESULT_LIMIT');
  return delivery;
}
/** Bounded read-only tools use the same wire budget without invocation-specific error semantics. */
export function boundedToolDelivery(id: RequestId, maximum: number): RuntimeServiceDelivery | null {
  const overhead = wireBytes(id, completeToolResult({ content: [{ type: 'text', text: '' }], structuredContent: {} }));
  // Serialized inner JSON has no raw controls: quoting it adds at most one byte per byte.
  // Text therefore costs <=2n and its structured duplicate <=n. Empty placeholders remain slack.
  const available = (BigInt(maximum) - overhead) / 3n;
  if (available <= 0n) return null;
  return Object.freeze({ maxResultBytes: Number(available) });
}
