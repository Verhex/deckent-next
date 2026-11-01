import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { largeResourceProposalFixture } from '../support/run-proposal.js';
import { taskGraphSchema, validateTaskGraph } from '#domain/index.js';
import type { ModelIngressProjection } from '#engine/index.js';
import { INPUT_VALIDATION_LIMITS, graphInputValidationLimit, inputWithinValidationLimit } from '#platform/core/common/index.js';

it.each(['\u200b', '\u202e', '\u{e0070}\u{e0077}\u{e006e}'])('guards worker and direct MCP arguments %s on the same handler before effects', async mark => {
  const received: unknown[] = [], notices: ModelIngressProjection[] = [];
  const server = createMcpServer({ async inspectRun(query) { received.push(query); return { ok: true }; }, async inspectInventory() { return {}; },
    async recordModelIngress(notice) { notices.push(notice); } }, { maxConcurrentCalls: 1, responseMaxBytes: 4096 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: 'native-worker', version: '1' }); await client.connect(ct);
  try {
    const query = { schemaVersion: 1, scopeId: 's', runId: 'r' };
    for (const args of [{ ...query, runId: 'private' + mark }, { ...query, ['key' + mark]: 'private' }, { ...query, extra: { values: ['private' + mark] } }]) {
      const result = await client.callTool({ name: 'inspect_run', arguments: args });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('MCP_INPUT_INVALID');
      expect(JSON.stringify(result)).toContain('ingress-refused:arguments');
      expect(JSON.stringify(result)).not.toContain('private'); expect(JSON.stringify(result)).not.toContain('pwn');
    }
    expect(received).toEqual([]); expect(notices).toHaveLength(3);
    expect((await client.callTool({ name: 'inspect_run', arguments: query })).isError).not.toBe(true);
    expect(received).toEqual([query]); expect(notices).toHaveLength(3);
  } finally { await client.close(); await server.close(); }
});

it('refuses before dispatch if MCP audit fails, then releases the concurrency slot', async () => {
  let entered = 0, proposed = 0;
  const server = createMcpServer({ async inspectRun() { entered++; return {}; }, async inspectInventory() { return {}; }, async proposeRun() { proposed++; return {}; },
    async recordModelIngress() { throw new Error('audit unavailable'); } }, { maxConcurrentCalls: 1, responseMaxBytes: 4096 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: 'worker', version: '1' }); await client.connect(ct);
  try {
    // Worked graph: 256 independent tasks, each touching the v5 maximum 64 business records.
    const proposal = largeResourceProposalFixture();
    const graph = taskGraphSchema.parse(proposal.graph); validateTaskGraph(graph);
    const graphLimit = graphInputValidationLimit(); expect(graphLimit.maxNodes).toBe(83968);
    expect(graphInputValidationLimit({ maxTasks: 1, maxEdges: 1024, maxDepth: 64 }).maxNodes).toBe(4392);
    expect(graphInputValidationLimit({ maxTasks: 256, maxEdges: 1024, maxDepth: 1 }).maxNodes).toBe(79872);
    expect(graphInputValidationLimit({ maxTasks: 512, maxEdges: 2048, maxDepth: 128 })).toEqual(graphLimit);
    expect((await client.callTool({ name: 'propose_run', arguments: proposal })).isError).not.toBe(true); expect(proposed).toBe(1);
    expect(JSON.stringify(await client.callTool({ name: 'inspect_run', arguments: proposal }))).toContain('MCP_INPUT_INVALID');
    expect(proposed).toBe(1); expect(entered).toBe(0);
    expect(inputWithinValidationLimit({ values: Array(graphLimit.maxNodes - 3).fill(0) }, graphLimit)).toBe(true);
    expect(inputWithinValidationLimit({ values: Array(graphLimit.maxNodes - 2).fill(0) }, graphLimit)).toBe(false);
    expect(JSON.stringify(await client.callTool({ name: 'propose_run', arguments: { values: Array(graphLimit.maxNodes - 2).fill(0) } }))).toContain('MCP_INPUT_INVALID');
    expect(proposed).toBe(1);
    const limit = INPUT_VALIDATION_LIMITS.mcp;
    expect(inputWithinValidationLimit({ values: Array(limit.maxNodes - 3).fill(0) }, limit)).toBe(true);
    expect(inputWithinValidationLimit({ values: Array(limit.maxNodes - 2).fill(0) }, limit)).toBe(false);
    expect(JSON.stringify(await client.callTool({ name: 'inspect_run', arguments: { values: Array(limit.maxNodes - 2).fill(0) } }))).toContain('MCP_INPUT_INVALID');
    expect(entered).toBe(0);
    expect(JSON.stringify(await client.callTool({ name: 'inspect_run', arguments: { schemaVersion: 1, scopeId: 's', runId: 'x\u200by' } }))).toContain('result withheld');
    expect(entered).toBe(0);
    expect((await client.callTool({ name: 'inspect_run', arguments: { schemaVersion: 1, scopeId: 's', runId: 'r' } })).isError).not.toBe(true);
    expect(entered).toBe(1);
    const narrow = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
      async proposeRun() { proposed++; return {}; } }, { maxConcurrentCalls: 1, responseMaxBytes: 4096, graph: { maxTasks: 1, maxEdges: 1024, maxDepth: 64 } }, 'en');
    const [nc, ns] = InMemoryTransport.createLinkedPair(); await narrow.connect(ns);
    const narrowedClient = new Client({ name: 'narrowed-worker', version: '1' }); await narrowedClient.connect(nc);
    try {
      expect(JSON.stringify(await narrowedClient.callTool({ name: 'propose_run', arguments: proposal }))).toContain('MCP_INPUT_INVALID');
      expect(proposed).toBe(1);
    } finally { await narrowedClient.close(); await narrow.close(); }
  } finally { await client.close(); await server.close(); }
});
