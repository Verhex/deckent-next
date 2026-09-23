import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/index.js';

it('advertises inference plan and budget as read-only tools when composition supplies them', async () => {
  const server = createMcpServer({
    async inspectRun() { return null; },
    async inspectInventory() { return null; },
    async inferencePlan(input) { return { schemaVersion: 1, configured: false, profileId: input.profileId ?? null }; },
    async inferenceBudget() { return { schemaVersion: 1, configured: false, estimate: 'empty-budget-not-a-reservation' }; },
  }, { maxConcurrentCalls: 2, responseMaxBytes: 8000 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name);
    expect(names).toContain('inference_plan');
    expect(names).toContain('inference_budget');
    expect(tools.tools.find(tool => tool.name === 'inference_plan')?.annotations?.readOnlyHint).toBe(true);
    const plan = await client.callTool({ name: 'inference_plan', arguments: { profileId: 'host' } });
    expect(JSON.stringify(plan)).toContain('host');
    const budget = await client.callTool({ name: 'inference_budget', arguments: {} });
    expect(JSON.stringify(budget)).toContain('empty-budget-not-a-reservation');
  } finally {
    await client.close();
    await server.close();
  }
});
