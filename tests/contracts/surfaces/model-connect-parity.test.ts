import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { ModelConnectCommand, ModelConnectResult } from '#domain/index.js';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';
import { modelsCommand } from '#surfaces/core/cli-models/index.js';
import { connectConfiguredModel } from '#composition/core/model-connect/index.js';
import * as sdk from '../../../src/index.js';

// T4-B models.connect: one typed contract on every surface — the CLI, MCP and the SDK hand the same command to the same application and return
// the same result shape (the terminal's /provider model step calls the CLI context's handler, see terminal-provider-model-ports).
const result: ModelConnectResult = { schemaVersion: 1, operation: 'models.connect', commandId: 'c-1', scopeId: 'scope', connection: 'openai-api', status: 'connected',
  reference: { providerId: 'openai-api', providerVersion: 1, modelId: 'gpt-6-luna', modelVersion: 1 }, credentialRef: 'DECKENT_OPENAI_KEY', keyStored: true,
  steps: { catalog: 'written', declaration: 'written', profile: 'written', activation: 'written', carried: 0 }, tariff: 'unmetered', approval: null, service: 'current' };
const command: ModelConnectCommand = { schemaVersion: 1, commandId: 'c-1', scopeId: 'scope', connection: 'openai-api', endpoint: null, model: { nativeId: 'gpt-6-luna' } };

describe('models.connect surface parity', () => {
  it('the CLI parses its flags into the one command and prints the application result unchanged as JSON', async () => {
    const seen: unknown[] = [], out: string[] = [];
    await modelsCommand(['models', 'connect', '--scope', 'scope', '--connection', 'openai-api', '--model', 'gpt-6-luna', '--command-id', 'c-1', '--json'], {
      root: '/project', env: {}, stdout: { write: (text: string) => { out.push(text); return true; } } as never,
      connectModel: async (_root, input) => { seen.push(input); return result; } });
    expect(seen).toEqual([command]);
    expect(JSON.parse(out.join(''))).toEqual(result);
    // An exact declared reference instead of a seed id.
    seen.length = 0;
    await modelsCommand(['models', 'connect', '--scope', 'scope', '--connection', 'local-openai', '--endpoint', 'http://127.0.0.1:8000', '--reference', 'local@1/qwen@2',
      '--command-id', 'c-2', '--json'], { root: '/project', env: {}, stdout: { write: () => true } as never, connectModel: async (_root, input) => { seen.push(input); return result; } });
    expect(seen).toEqual([{ schemaVersion: 1, commandId: 'c-2', scopeId: 'scope', connection: 'local-openai', endpoint: 'http://127.0.0.1:8000',
      model: { reference: { providerId: 'local', providerVersion: 1, modelId: 'qwen', modelVersion: 2 } } }]);
    // Exactly one of --model / --reference.
    await expect(modelsCommand(['models', 'connect', '--scope', 'scope', '--connection', 'openai-api', '--command-id', 'c-3'], { root: '/p', env: {},
      connectModel: async () => result })).rejects.toMatchObject({ code: 'CLI_USAGE' });
  });

  it('MCP connect_model takes the same command schema and returns the same result', async () => {
    const seen: unknown[] = [];
    const server = createMcpServer({ connectModel: async (input: ModelConnectCommand) => { seen.push(input); return result; } } as McpApplications,
      { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'model-connect-parity', version: '1' });
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find(item => item.name === 'connect_model');
      expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(['schemaVersion', 'commandId', 'scopeId', 'connection', 'model']));
      const called = await client.callTool({ name: 'connect_model', arguments: command });
      expect(seen).toEqual([command]);
      expect(called.structuredContent ?? JSON.parse((called.content as { text: string }[])[0]!.text)).toEqual(result);
    } finally { await client.close(); await server.close(); }
  });

  it('the SDK exports the same application function', () => {
    expect(sdk.connectModel).toBe(connectConfiguredModel);
  });
});
