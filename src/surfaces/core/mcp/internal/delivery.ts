import type { CallToolResult, RequestId } from '@modelcontextprotocol/server';
import { PACKAGE_NAME, PACKAGE_VERSION } from '#platform/index.js';
import { mcpToolResultDeliveryCapacity, ModelInvocationStoreError, type ModelInvocationDelivery, type RuntimeServiceDelivery } from '#engine/index.js';
// The SDK's `SERVER_INFO_META_KEY`, inlined so this module does not load the whole server SDK at import time (~105 ms in every process; STARTUP-COST).
// tests/contracts/composition/startup-graph.test.ts fails when the SDK's value ever differs.
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

/** Author fields that the pinned SDK would otherwise add after tools/call returns.
 * tools/call is not cacheable. Both supported codec eras preserve these authored fields. */
export function completeToolResult(result: CallToolResult): CallToolResult {
  return { ...result, resultType: 'complete', _meta: { [SERVER_INFO_META_KEY]: { name: PACKAGE_NAME, version: PACKAGE_VERSION } } };
}
/** A tool's JSON value as text, duplicated as structuredContent only when it is a JSON object (protocol requirement): a list result
 * (list_approvals) travels as text only, never as an array a validating client rejects. */
export function jsonToolResult(value: unknown): CallToolResult {
  const encoded = JSON.stringify(value), structured = JSON.parse(encoded) as unknown;
  return completeToolResult({ content: [{ type: 'text', text: encoded }],
    ...(structured !== null && typeof structured === 'object' && !Array.isArray(structured) ? { structuredContent: structured as Record<string, unknown> } : {}) });
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
  // Shared arithmetic (SESSION-RESULT-LIMIT-2026-09-28): a static profile check below this layer
  // (composition doctor/activation, via the mcp-transport adapter) reuses the same engine formula.
  return mcpToolResultDeliveryCapacity(maximum, overhead);
}
