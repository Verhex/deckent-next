import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';

// MCP `structuredContent` must be a JSON object; a list result (list_approvals answers an array of records) travels as text only,
// otherwise a validating client rejects the whole tools/call (found by the C12 G4 MCP stdio acceptance: list → decide → resubmit).
it('delivers an array result as text without structuredContent, and an object result with both (C12 G4)', async () => {
  const record = { request: { approvalId: 'a1' }, status: 'pending' };
  const applications = { async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    async listApprovals() { return [record]; }, async inspectApproval() { return record; } } as unknown as McpApplications;
  const server = createMcpServer(applications, { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-structured-content', version: '1' });
  await client.connect(clientTransport);
  try {
    const listed = await client.callTool({ name: 'list_approvals', arguments: { schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 } });
    expect(listed.isError).not.toBe(true); expect(listed.structuredContent).toBeUndefined();
    expect(JSON.parse((listed.content as { text: string }[])[0]!.text)).toEqual([record]);
    const inspected = await client.callTool({ name: 'inspect_approval', arguments: { schemaVersion: 1, scopeId: 's', approvalId: 'a1' } });
    expect(inspected.structuredContent).toEqual(record);
  } finally { await client.close(); await server.close(); }
});
