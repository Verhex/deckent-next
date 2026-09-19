import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { createMcpServer } from '../../../src/surfaces/core/mcp/index.js';
import type { DeclaredModelsInspection } from '#engine/index.js';

const declared: DeclaredModelsInspection = { schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog: {
  schemaVersion: 1, revision: 'catalog-1', providers: [{ id: 'provider-a', version: 1, models: [{ id: 'model-a', version: 2,
    nativeId: 'native/model-a', protocols: [{ family: 'responses', version: 'v1',
      capabilities: [{ id: 'text', version: 1, state: 'supported' }] }] }] }],
} };
const absent: DeclaredModelsInspection = { schemaVersion: 1, status: 'not-configured', availability: 'not-observed', catalog: null };
function sink() { const values: string[] = []; return { values, output: { write(value: string) { values.push(value); } } }; }

it('CLI emits the injected declaration contract unchanged as JSON and treats absence as success', async () => {
  for (const result of [declared, absent]) {
    const target = sink(); let call: unknown;
    const code = await main(['models', '--json'], { root: '/project', env: { HOME: '/tmp/models' }, stdout: target.output, stderr: target.output,
      initialize() {}, async inspectDeclaredModels(root, options) { call = { root, home: options.env?.['HOME'] }; return result; } });
    expect(code).toBe(0); expect(JSON.parse(target.values.join(''))).toEqual(result); expect(call).toEqual({ root: '/project', home: '/tmp/models' });
  }
});

it('CLI human output preserves native protocol declarations while denying observed availability', async () => {
  for (const [locale, semantic] of [['en', 'not observed'], ['tr', 'gözlemlenmedi']] as const) {
    const target = sink();
    expect(await main(['models', '--lang', locale, '--no-color'], { stdout: target.output, stderr: target.output, initialize() {},
      async inspectDeclaredModels() { return declared; } })).toBe(0);
    const text = target.values.join(''); expect(text).toContain('native/model-a'); expect(text).toContain('responses@v1');
    expect(text.toLowerCase()).toContain(semantic);
  }
});

it('CLI rejects duplicate and unknown flags before invoking inspection', async () => {
  let calls = 0; const target = sink(); const context = { stdout: target.output, stderr: target.output, initialize() {},
    async inspectDeclaredModels() { calls++; return absent; } };
  expect(await main(['models', '--json', '--json'], context)).toBe(2);
  expect(await main(['models', '--provider', 'provider-a'], context)).toBe(2);
  expect(await main(['models', '--lang', 'en', '--lang', 'tr'], context)).toBe(2);
  expect(calls).toBe(0);
});

it('MCP advertises the optional closed-world read tool and preserves the same result', async () => {
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    async inspectDeclaredModels() { return declared; } }, { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'declared-models-test', version: '1' }); await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools.find(value => value.name === 'list_declared_models');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect((await client.callTool({ name: 'list_declared_models', arguments: {} })).structuredContent).toEqual(declared);
    expect(JSON.stringify(await client.callTool({ name: 'list_declared_models', arguments: { provider: 'forged' } }))).toContain('MCP_INPUT_INVALID');
  } finally { await client.close(); await server.close(); }
});

it('MCP omits the tool when local metadata inspection is not composed', async () => {
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; } },
    { maxConcurrentCalls: 1, responseMaxBytes: 4096 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'declared-models-absent-test', version: '1' }); await client.connect(clientTransport);
  try { expect((await client.listTools()).tools.some(tool => tool.name === 'list_declared_models')).toBe(false); }
  finally { await client.close(); await server.close(); }
});
