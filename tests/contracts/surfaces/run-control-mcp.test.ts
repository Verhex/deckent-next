import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
it('exposes policy-gated hold/resume through one command contract and refuses human answers at the MCP wire', async () => {
  const received: unknown[] = [];
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    async applyRunControl(command) { received.push(command); return { command }; } }, { maxConcurrentCalls: 2, responseMaxBytes: 8192 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: 'input-hold-test', version: '1' }); await client.connect(ct);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === 'control_run')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(tools.some(tool => /answer|accept|decide/.test(tool.name))).toBe(false);
    const base = { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'hold', expectedRevision: 0 };
    expect((await client.callTool({ name: 'control_run', arguments: { ...base, action: 'hold', holdReason: 'Wait' } })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'control_run', arguments: { ...base, action: 'resume', commandId: 'resume', expectedRevision: 1 } })).isError).not.toBe(true);
    for (const invalid of [{ action: 'answer', taskId: 't', answer: 'EU' }, { action: 'accept', taskId: 't' }, { action: 'hold', holdReason: 'Wait', principal: 'owner' },
      { action: 'resume', answer: 'EU', taskId: 't' }, { action: 'hold', holdReason: '' }]) {
      expect(JSON.stringify(await client.callTool({ name: 'control_run', arguments: { ...base, ...invalid } }))).toContain('MCP_INPUT_INVALID');
    }
    expect(received).toHaveLength(2);
  } finally { await client.close(); await server.close(); }
});
