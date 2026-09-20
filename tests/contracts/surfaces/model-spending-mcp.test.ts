import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/index.js';
import type { ProviderSpendAccountQuery, ProviderSpendAuditCommand } from '#domain/index.js';
import type { ProviderSpendAccountInspection, ProviderSpendAuditResult, RuntimeServiceDelivery } from '#engine/index.js';
import { ErrorRegistry } from '#platform/index.js';

const query: ProviderSpendAccountQuery = { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', budgetRevision: 1 };
const audit: ProviderSpendAuditCommand = { schemaVersion: 1, commandId: 'audit', ...query, expectedCheckpointDigest: 'a'.repeat(64) };
const connections: { client: Client; server: ReturnType<typeof createMcpServer> }[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(async value => { await value.client.close(); await value.server.close(); })); });

it('advertises and invokes bounded strict provider-spending inspection without invocation content', async () => {
  const calls: { input?: ProviderSpendAccountQuery; delivery?: RuntimeServiceDelivery } = {};
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    async inspectProviderSpendAccount(input, delivery) { calls.input = input; calls.delivery = delivery;
      return { ...input, schemaVersion: 2, checkpoint: null, audit: null, spendingHistoryIntegrity: 'not-recorded' } as ProviderSpendAccountInspection; },
  }, { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'spending-mcp-test', version: '1' }); await client.connect(clientTransport); connections.push({ client, server });
  const tool = (await client.listTools()).tools.find(value => value.name === 'inspect_provider_spending')!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true });
  expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['schemaVersion', 'scopeId', 'budgetId', 'budgetRevision'] });
  const response = await client.callTool({ name: tool.name, arguments: query });
  expect(calls.input).toEqual(query); expect(calls.delivery?.maxResultBytes).toBeGreaterThan(0);
  expect(JSON.stringify(response)).toContain('not-recorded'); expect(JSON.stringify(response)).not.toContain('nativeRequest');
  expect(JSON.stringify(await client.callTool({ name: tool.name, arguments: { ...query, forged: true } }))).toContain('MCP_INPUT_INVALID');
});

async function accountClient(responseMaxBytes: number, inspect: (input: ProviderSpendAccountQuery, delivery?: RuntimeServiceDelivery) => Promise<ProviderSpendAccountInspection>) {
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; }, inspectProviderSpendAccount: inspect },
    { maxConcurrentCalls: 2, responseMaxBytes }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'spending-mcp-limit-test', version: '1' }); await client.connect(clientTransport); connections.push({ client, server });
  return client;
}

it('rejects an account inspection before its application when the MCP response budget has no bounded payload capacity', async () => {
  let calls = 0;
  const client = await accountClient(1, async input => { calls++; return { ...input, schemaVersion: 2, checkpoint: null, audit: null, spendingHistoryIntegrity: 'not-recorded' }; });
  const result = JSON.stringify(await client.callTool({ name: 'inspect_provider_spending', arguments: query }));
  expect(calls).toBe(0); expect(result).toContain('MCP_RESPONSE_LIMIT'); expect(result).not.toContain('MODEL_INVOCATION_RESULT_LIMIT');
});

it('maps a runtime account response-capacity rejection to the generic MCP limit after the application is called', async () => {
  let calls = 0;
  const client = await accountClient(65536, async () => { calls++; throw ErrorRegistry.createError('RUNTIME_SERVICE_RESPONSE_LIMIT'); });
  const result = JSON.stringify(await client.callTool({ name: 'inspect_provider_spending', arguments: query }));
  expect(calls).toBe(1); expect(result).toContain('MCP_RESPONSE_LIMIT'); expect(result).not.toContain('MODEL_INVOCATION_RESULT_LIMIT');
});

it('advertises bounded durable account auditing with strict input and no open-world side effect', async () => {
  const calls: { command?: ProviderSpendAuditCommand; delivery?: RuntimeServiceDelivery } = {};
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    async auditProviderSpendAccount(command, delivery) { calls.command = command; calls.delivery = delivery;
      return { schemaVersion: 1, replayed: false, receipt: {} } as ProviderSpendAuditResult; },
  }, { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'spending-audit-mcp-test', version: '1' }); await client.connect(clientTransport); connections.push({ client, server });
  const tool = (await client.listTools()).tools.find(value => value.name === 'audit_provider_spending')!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true });
  expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false,
    required: expect.arrayContaining(['schemaVersion', 'commandId', 'scopeId', 'budgetId', 'budgetRevision', 'expectedCheckpointDigest']) });
  expect(JSON.stringify(await client.callTool({ name: tool.name, arguments: audit }))).toContain('replayed');
  expect(calls.command).toEqual(audit); expect(calls.delivery?.maxResultBytes).toBeGreaterThan(0);
  expect(JSON.stringify(await client.callTool({ name: tool.name, arguments: { ...audit, forged: true } }))).toContain('MCP_INPUT_INVALID');
});
