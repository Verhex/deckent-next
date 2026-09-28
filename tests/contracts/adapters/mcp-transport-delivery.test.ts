import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { mcpToolDeliveryCapacityForProbe } from '#adapters/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';

// SESSION-RESULT-LIMIT-2026-09-28 review: composition's doctor/activation audit cannot reach surfaces/core/mcp
// directly (guards the real perf regression tests/contracts/composition/sdk-import-graph.test.ts proves), so it
// probes MCP delivery capacity through this adapter instead. The shared arithmetic (mcpToolResultDeliveryCapacity,
// engine) is never duplicated, but the reference-envelope construction genuinely is (surfaces/core/mcp needs its
// own copy — it cannot import the adapter either). This test proves the two envelopes still agree exactly, for a
// plain id and one with escapes/multibyte/a lone surrogate (the same id shapes delivery.ts already proves for).
it.each(['probe', 'request-"\\🎯\ud800', ''])('mcpToolDeliveryCapacityForProbe matches the real MCP server\'s boundedToolDelivery for id %j', async id => {
  const maximum = 65_536;
  let supplied: { maxResultBytes: number } | undefined;
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    async listApprovals(_input, delivery) { supplied = delivery as { maxResultBytes: number } | undefined; return []; } },
    { maxConcurrentCalls: 1, responseMaxBytes: maximum }, 'en');
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const responses: JSONRPCMessage[] = []; client.onmessage = message => { responses.push(message); };
  await server.connect(transport); await client.start();
  try {
    await client.send({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'list_approvals', arguments: { schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 } } });
    await expect.poll(() => responses.length).toBeGreaterThan(0);
    expect(supplied).toBeDefined();
    expect(mcpToolDeliveryCapacityForProbe(id, maximum)).toEqual(supplied);
  } finally { await client.close(); await server.close(); }
});
