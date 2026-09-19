import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { createMcpServer } from '../../../src/surfaces/core/mcp/index.js';
import type { ModelReference } from '#domain/index.js';
import type { ModelBindingInspection } from '#engine/index.js';

const reference: ModelReference = { providerId: 'provider-a', providerVersion: 2, modelId: 'model-a', modelVersion: 3 };
const declared: ModelBindingInspection = { schemaVersion: 1, reference, status: 'declared', catalogRevision: 'catalog-a',
  definition: { encodingVersion: 1, provider: { id: 'provider-a', version: 2 },
    model: { id: 'model-a', version: 3, nativeId: 'native/a', protocols: [{ family: 'responses', version: 'v1',
      capabilities: [{ id: 'text', version: 1, state: 'supported' }] }] } },
  binding: { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) }, availability: 'not-observed' };
function sink() { const values: string[] = []; return { values, output: { write(value: string) { values.push(value); } } }; }
const argv = ['models', 'binding', '--provider', 'provider-a', '--provider-version', '2', '--model', 'model-a', '--model-version', '3', '--json'];

it('CLI passes the exact versioned reference and emits the binding inspection unchanged', async () => {
  const target = sink(); let received: unknown;
  const code = await main(argv, { root: '/project', env: { HOME: '/private/home' }, stdout: target.output, stderr: target.output, initialize() {},
    async inspectModelBinding(root, input, options) { received = { root, input, home: options.env?.['HOME'] }; return declared; } });
  expect(code).toBe(0); expect(received).toEqual({ root: '/project', input: reference, home: '/private/home' });
  expect(JSON.parse(target.values.join(''))).toEqual(declared);
});

it('CLI rejects incomplete, unsafe integer, duplicate, and unknown input before invocation', async () => {
  let calls = 0; const target = sink(); const context = { stdout: target.output, stderr: target.output, initialize() {},
    async inspectModelBinding() { calls++; return declared; } };
  const invalid = [argv.slice(0, -2), argv.map(value => value === '2' ? '0' : value), argv.map(value => value === '3' ? '01' : value),
    argv.map(value => value === 'provider-a' ? '\u0000bad' : value), [...argv, '--provider', 'other'], [...argv, '--unknown']];
  for (const args of invalid) expect(await main(args, context)).toBe(2);
  expect(calls).toBe(0);
});

it('CLI delegates an unknown locale to locale resolution fallback', async () => {
  const target = sink(); let calls = 0;
  expect(await main([...argv, '--lang', 'unsupported'], { stdout: target.output, stderr: target.output, initialize() {},
    async inspectModelBinding() { calls++; return declared; } })).toBe(0);
  expect(calls).toBe(1); expect(JSON.parse(target.values.join(''))).toEqual(declared);
});

it('MCP exposes an optional strict closed-world read tool with the exact flat reference', async () => {
  let received: unknown;
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    async inspectModelBinding(input) { received = input; return declared; } }, { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'model-binding-surface', version: '1' }); await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools.find(value => value.name === 'inspect_model_binding');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect((await client.callTool({ name: 'inspect_model_binding', arguments: reference })).structuredContent).toEqual(declared);
    expect(received).toEqual(reference);
    expect(JSON.stringify(await client.callTool({ name: 'inspect_model_binding', arguments: { ...reference, provider: 'forged' } }))).toContain('MCP_INPUT_INVALID');
    expect(JSON.stringify(await client.callTool({ name: 'inspect_model_binding', arguments: { ...reference, modelVersion: 0 } }))).toContain('MCP_INPUT_INVALID');
  } finally { await client.close(); await server.close(); }
});

it('MCP omits binding inspection unless composition injects it', async () => {
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; } },
    { maxConcurrentCalls: 1, responseMaxBytes: 4096 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'model-binding-optional', version: '1' }); await client.connect(clientTransport);
  try { expect((await client.listTools()).tools.some(tool => tool.name === 'inspect_model_binding')).toBe(false); }
  finally { await client.close(); await server.close(); }
});
