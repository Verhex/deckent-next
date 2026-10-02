import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/core/mcp/index.js';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(close.splice(0).map(fn => fn())); });
async function fixture() {
  const calls: unknown[] = [], result = { schemaVersion: 1, decisionId: 'decision', advice: null, status: 'unknown' };
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    inspectDecision: async (input: unknown) => { calls.push(input); return result; },
    // An untrusted caller supplying a mutator must never make it discoverable or callable.
    askDecision: async () => { throw new Error('UNAUTHORIZED_DECISION'); },
    recordDecision: async () => { throw new Error('UNAUTHORIZED_DECISION'); },
  } as never, { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'decision-mcp-test', version: '1' }); await client.connect(clientTransport);
  close.push(async () => { await client.close(); await server.close(); }); return { client, calls, result };
}
it('advertises only read-only decision inspection and refuses all decision mutations', async () => {
  const f = await fixture(), tools = (await f.client.listTools()).tools;
  expect(tools.find(tool => tool.name === 'inspect_decision')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  for (const name of ['ask_decision', 'record_decision', 'decide', 'outcome_decision']) {
    expect(tools.map(tool => tool.name)).not.toContain(name);
    expect(JSON.stringify(await f.client.callTool({ name, arguments: {} }))).toContain('MCP_TOOL_UNKNOWN');
  }
});
it('delivers strict inspect query to the application and returns recorded data', async () => {
  const f = await fixture(), query = { schemaVersion: 1, scopeId: 'scope', decisionId: 'decision' };
  const result = await f.client.callTool({ name: 'inspect_decision', arguments: query }); expect(result.structuredContent).toEqual(f.result);
  expect(f.calls).toEqual([query]);
  expect(JSON.stringify(await f.client.callTool({ name: 'inspect_decision', arguments: { ...query, selectedOption: 'forged' } }))).toContain('MCP_INPUT_INVALID');
  expect(f.calls).toEqual([query]);
});
