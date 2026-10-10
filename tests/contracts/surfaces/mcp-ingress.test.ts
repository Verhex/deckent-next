import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import type { ModelIngressProjection } from '#engine/index.js';

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
  let entered = 0;
  const server = createMcpServer({ async inspectRun() { entered++; return {}; }, async inspectInventory() { return {}; },
    async recordModelIngress() { throw new Error('audit unavailable'); } }, { maxConcurrentCalls: 1, responseMaxBytes: 4096 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: 'worker', version: '1' }); await client.connect(ct);
  try {
    expect(JSON.stringify(await client.callTool({ name: 'inspect_run', arguments: { schemaVersion: 1, scopeId: 's', runId: 'x\u200by' } }))).toContain('result withheld');
    expect(entered).toBe(0);
    expect((await client.callTool({ name: 'inspect_run', arguments: { schemaVersion: 1, scopeId: 's', runId: 'r' } })).isError).not.toBe(true);
    expect(entered).toBe(1);
  } finally { await client.close(); await server.close(); }
});
