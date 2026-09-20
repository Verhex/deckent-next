import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/index.js';
import type { ModelInvocationCancellationCommand, ModelInvocationCommand, ModelInvocationPurgeCommand, ModelInvocationQuery } from '#domain/index.js';
import type { ModelInvocationCancellationResult, ModelInvocationInspection, ModelInvocationPurgeResult, ModelInvocationResult } from '#engine/index.js';

const reference = { providerId: 'provider-a', providerVersion: 1, modelId: 'model-a', modelVersion: 1 };
const query: ModelInvocationQuery = { schemaVersion: 2, scopeId: 'scope-a', invocationId: 'invocation-a', reference };
const command: ModelInvocationCommand = { schemaVersion: 1, commandId: 'command-a', scopeId: 'scope-a', reference,
  catalogRevision: 'catalog-a', expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) },
  nativeRequest: { model: 'native-a', messages: [{ role: 'user', content: 'bounded fixture' }] } };
const purge: ModelInvocationPurgeCommand = { schemaVersion: 1, commandId: 'purge-a', scopeId: 'scope-a', invocationId: 'invocation-a',
  reference, expectedContentDigest: 'a'.repeat(64) };
const cancellation: ModelInvocationCancellationCommand = { schemaVersion: 1, commandId: 'cancel-a', scopeId: 'scope-a', targetCommandId: 'command-a',
  reference, expectedRequestDigest: 'a'.repeat(64) };
const inspection: ModelInvocationInspection = { ...query, invocation: null, contentStatus: null };
const result = { replayed: false, receipt: { fixture: 'native invocation is not a provider call' } } as unknown as ModelInvocationResult;

const connected: { client: Client; close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(connected.splice(0).map(value => value.close())); });

async function fixture(include = true) {
  const calls: { invoke: unknown[]; inspect: unknown[]; purge: unknown[]; cancel: unknown[] } = { invoke: [], inspect: [], purge: [], cancel: [] };
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    ...(include ? {
      async invokeModel(input: ModelInvocationCommand) { calls.invoke.push(input); return result; },
      async inspectModelInvocation(input: ModelInvocationQuery) { calls.inspect.push(input); return inspection; },
      async purgeModelInvocationContent(input: ModelInvocationPurgeCommand): Promise<ModelInvocationPurgeResult> { calls.purge.push(input); return { replayed: false,
        receipt: { schemaVersion: 1, command: input, actor: { id: 'actor', issuer: 'issuer', subject: 'subject', assurance: 'os-user' },
          authorization: { revision: 'allow', ruleId: 'purge-content' }, purgedAtMs: 1 } }; },
      async cancelModelInvocation(input: ModelInvocationCancellationCommand): Promise<ModelInvocationCancellationResult> { calls.cancel.push(input); return { replayed: false,
        receipt: { schemaVersion: 1, command: input, claim: { scopeId: 'scope-a', commandId: 'command-a', invocationId: 'invocation-a',
          requestDigest: input.expectedRequestDigest, profileDigest: 'b'.repeat(64) }, actor: { id: 'actor', issuer: 'issuer', subject: 'subject', assurance: 'os-user' },
        authorization: { revision: 'allow', ruleId: 'cancel-invocation' }, requestedAtMs: 1, disposition: 'requested' } }; },
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
  const purgeContent = tools.find(tool => tool.name === 'purge_model_invocation_content')!;
  const cancel = tools.find(tool => tool.name === 'cancel_model_invocation')!;
  expect(invoke.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  expect(inspect.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  expect(purgeContent.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  expect(cancel.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  expect(invoke.inputSchema).toMatchObject({ type: 'object', additionalProperties: false,
    required: expect.arrayContaining(['schemaVersion', 'commandId', 'scopeId', 'reference', 'catalogRevision', 'expectedBinding', 'nativeRequest']) });
  expect(inspect.inputSchema).toMatchObject({ type: 'object', additionalProperties: false,
    required: expect.arrayContaining(['schemaVersion', 'scopeId', 'invocationId', 'reference']) });
  expect(purgeContent.inputSchema).toMatchObject({ type: 'object', additionalProperties: false,
    required: expect.arrayContaining(['schemaVersion', 'commandId', 'scopeId', 'invocationId', 'reference', 'expectedContentDigest']) });
  expect(cancel.inputSchema).toMatchObject({ type: 'object', additionalProperties: false,
    required: expect.arrayContaining(['schemaVersion', 'commandId', 'scopeId', 'targetCommandId', 'reference', 'expectedRequestDigest']) });
});

it('forwards only parsed command and query objects to injected applications', async () => {
  const f = await fixture();
  const invoked = await f.client.callTool({ name: 'invoke_model', arguments: command });
  const inspected = await f.client.callTool({ name: 'inspect_model_invocation', arguments: query });
  const purged = await f.client.callTool({ name: 'purge_model_invocation_content', arguments: purge });
  const cancelled = await f.client.callTool({ name: 'cancel_model_invocation', arguments: cancellation });
  expect(invoked.isError).not.toBe(true);
  expect(invoked.structuredContent).toEqual(result);
  expect(inspected.isError).not.toBe(true);
  expect(inspected.structuredContent).toEqual(inspection);
  expect(purged.structuredContent).toMatchObject({ replayed: false, receipt: { command: purge, purgedAtMs: 1 } });
  expect(cancelled.structuredContent).toMatchObject({ replayed: false, receipt: { command: cancellation, disposition: 'requested' } });
  expect(f.calls).toEqual({ invoke: [command], inspect: [query], purge: [purge], cancel: [cancellation] });
});

it('rejects malformed or extended invocation input before either application is called', async () => {
  const f = await fixture();
  for (const [name, input] of [
    ['invoke_model', { ...command, untrusted: 'field' }],
    ['invoke_model', { ...command, expectedBinding: { ...command.expectedBinding, digest: 'not-a-digest' } }],
    ['inspect_model_invocation', { ...query, invocationId: '' }],
    ['inspect_model_invocation', { ...query, schemaVersion: 1 }],
    ['inspect_model_invocation', { ...query, provider: 'forged' }],
    ['purge_model_invocation_content', { ...purge, expectedContentDigest: 'not-a-digest' }],
    ['cancel_model_invocation', { ...cancellation, expectedRequestDigest: 'not-a-digest' }],
  ] as const) {
    expect(JSON.stringify(await f.client.callTool({ name, arguments: input }))).toContain('MCP_INPUT_INVALID');
  }
  expect(f.calls).toEqual({ invoke: [], inspect: [], purge: [], cancel: [] });
});

it('does not advertise invocation operations when composition does not inject applications', async () => {
  const f = await fixture(false);
  const names = (await f.client.listTools()).tools.map(tool => tool.name);
  expect(names).not.toContain('invoke_model');
  expect(names).not.toContain('inspect_model_invocation');
  expect(names).not.toContain('purge_model_invocation_content');
  expect(names).not.toContain('cancel_model_invocation');
});
