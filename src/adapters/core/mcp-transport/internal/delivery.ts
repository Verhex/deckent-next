import { SERVER_INFO_META_KEY, type CallToolResult, type RequestId } from '@modelcontextprotocol/server';
import { PACKAGE_NAME, PACKAGE_VERSION } from '#platform/index.js';
import { mcpToolResultDeliveryCapacity, type ModelInvocationDelivery } from '#engine/index.js';

/**
 * Mirrors surfaces/core/mcp's own empty-result envelope exactly (SESSION-RESULT-LIMIT-2026-09-28 review): a
 * static profile check (composition doctor/activation) needs the same probe outside the surfaces layer, which
 * composition may not import (guards a real perf regression: loading the surfaces barrel from composition at
 * runtime once cost `model-invocation-process` 36s — tests/contracts/composition/sdk-import-graph.test.ts).
 * The shared arithmetic lives in engine (`mcpToolResultDeliveryCapacity`), so only this trivial, stable envelope
 * shape is duplicated here, never the formula; tests/contracts/adapters/mcp-transport-delivery.test.ts
 * cross-checks this against the real MCP surface's `boundedToolDelivery` for identical output.
 */
function referenceEmptyToolResult(): CallToolResult {
  return { content: [{ type: 'text', text: '' }], structuredContent: {}, resultType: 'complete',
    _meta: { [SERVER_INFO_META_KEY]: { name: PACKAGE_NAME, version: PACKAGE_VERSION } } };
}
function wireBytes(id: RequestId, result: CallToolResult): bigint {
  return BigInt(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n', 'utf8'));
}
/** A static probe's MCP tool-result delivery capacity for a given wire budget — the same shape a real
 * `tools/call` bounds itself to, without needing a live MCP request/connection. */
export function mcpToolDeliveryCapacityForProbe(id: RequestId, maximum: number): ModelInvocationDelivery | null {
  return mcpToolResultDeliveryCapacity(maximum, wireBytes(id, referenceEmptyToolResult()));
}
