import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/index.js';
import type { ModelInvocationCommand, ModelInvocationQuery } from '#domain/index.js';
import type { ModelInvocationInspection, ModelInvocationResult } from '#engine/index.js';

const reference = { providerId: 'provider-a', providerVersion: 1, modelId: 'model-a', modelVersion: 1 };
const query: ModelInvocationQuery = { schemaVersion: 2, scopeId: 'scope-a', invocationId: 'invocation-a', reference };
const command: ModelInvocationCommand = { schemaVersion: 1, commandId: 'command-a', scopeId: 'scope-a', reference,
  catalogRevision: 'catalog-a', expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) },
  nativeRequest: { model: 'native-a', messages: [{ role: 'user', content: 'bounded fixture' }] } };
const inspection: ModelInvocationInspection = { ...query, invocation: null, contentStatus: null };
const result = { replayed: false, receipt: { fixture: 'native invocation is not a provider call' } } as unknown as ModelInvocationResult;

const connected: { client: Client; close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(connected.splice(0).map(value => value.close())); });

async function fixture(include = true) {
  const calls: { invoke: unknown[]; inspect: unknown[] } = { invoke: [], inspect: [] };
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    ...(include ? {
      async invokeModel(input: ModelInvocationCommand) { calls.invoke.push(input); return result; },
      async inspectModelInvocation(input: ModelInvocationQuery) { calls.inspect.push(input); return inspection; },
    } : {}),
  }, { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'model-invocation-mcp-test', version: '1' });
  await client.connect(clientTransport);
  connected.push({ client, async close() { await client.close(); await server.close(); } });
  return { client, calls };
}

it('advertises injected native invocation as an explicit open-world mutator and inspection as a strict reader', async () => {
  const f = await fixture();
  const tools = (await f.client.listTools()).tools;
  const invoke = tools.find(tool => tool.name === 'invoke_model')!;
  const inspect = tools.find(tool => tool.name === 'inspect_model_invocation')!;
  expect(invoke.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  expect(inspect.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  expect(invoke.inputSchema).toMatchObject({ type: 'object', additionalProperties: false,
    required: expect.arrayContaining(['schemaVersion', 'commandId', 'scopeId', 'reference', 'catalogRevision', 'expectedBinding', 'nativeRequest']) });
  expect(inspect.inputSchema).toMatchObject({ type: 'object', additionalProperties: false,
    required: expect.arrayContaining(['schemaVersion', 'scopeId', 'invocationId', 'reference']) });
});

it('forwards only parsed command and query objects to injected applications', async () => {
  const f = await fixture();
  const invoked = await f.client.callTool({ name: 'invoke_model', arguments: command });
  const inspected = await f.client.callTool({ name: 'inspect_model_invocation', arguments: query });
  expect(invoked.isError).not.toBe(true);
  expect(invoked.structuredContent).toEqual(result);
  expect(inspected.isError).not.toBe(true);
  expect(inspected.structuredContent).toEqual(inspection);
  expect(f.calls).toEqual({ invoke: [command], inspect: [query] });
});

it('rejects malformed or extended invocation input before either application is called', async () => {
  const f = await fixture();
  for (const [name, input] of [
    ['invoke_model', { ...command, untrusted: 'field' }],
    ['invoke_model', { ...command, expectedBinding: { ...command.expectedBinding, digest: 'not-a-digest' } }],
    ['inspect_model_invocation', { ...query, invocationId: '' }],
    ['inspect_model_invocation', { ...query, schemaVersion: 1 }],
    ['inspect_model_invocation', { ...query, provider: 'forged' }],
  ] as const) {
    expect(JSON.stringify(await f.client.callTool({ name, arguments: input }))).toContain('MCP_INPUT_INVALID');
  }
  expect(f.calls).toEqual({ invoke: [], inspect: [] });
});

it('does not advertise invocation operations when composition does not inject applications', async () => {
  const f = await fixture(false);
  const names = (await f.client.listTools()).tools.map(tool => tool.name);
  expect(names).not.toContain('invoke_model');
  expect(names).not.toContain('inspect_model_invocation');
});
