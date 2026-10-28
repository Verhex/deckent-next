import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { ModelConnectCommand, ModelConnectResult } from '#domain/index.js';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';
import { modelsCommand } from '#surfaces/core/cli-models/index.js';
import { connectConfiguredModel } from '#composition/core/model-connect/index.js';
import { PROVIDER_CONNECT_KINDS, providerConnectFamily, providerConnectHelpKinds } from '#adapters/core/provider-connect/index.js';
import { main as cliMain } from '#surfaces/core/cli/index.js';
import * as sdk from '../../../src/index.js';

// T4-B models.connect: one typed contract on every surface — the CLI, MCP and the SDK hand the same command to the same application and return
// the same result shape (the terminal's /provider model step calls the CLI context's handler, see terminal-provider-model-ports).
const result: ModelConnectResult = { schemaVersion: 1, operation: 'models.connect', commandId: 'c-1', scopeId: 'scope', connection: 'openai-api', status: 'connected',
  reference: { providerId: 'openai-api', providerVersion: 1, modelId: 'gpt-6-luna', modelVersion: 1 }, credentialRef: 'DECKENT_OPENAI_KEY', keyStored: true,
  steps: { catalog: 'written', declaration: 'written', profile: 'written', activation: 'written', carried: 0 }, notCarried: [], carriedModels: [], tariff: 'unmetered', approval: null, service: 'current' };
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
    // Both model forms together remain invalid; omission requests a pull.
    await modelsCommand(['models', 'connect', '--scope', 'scope', '--connection', 'anthropic-api', '--command-id', 'pull'], {
      env: {}, connectModel: async (_root, input) => { expect(input.model).toEqual({ pull: 'available' }); return result; }, stdout: { write: () => true } as never });
    await expect(modelsCommand(['models', 'connect', '--scope', 'scope', '--connection', 'anthropic-api', '--command-id', 'bad', '--model', 'x', '--reference', 'p@1/m@1'], {
      env: {}, connectModel: async () => result })).rejects.toMatchObject({ code: 'CLI_USAGE' });
  });

  it('BeUser M-26: --scope defaults to an explicit flag or this folder\'s scope and --command-id is generated; a refusal names the argument', async () => {
    const seen: ModelConnectCommand[] = [], context = { root: '/project', env: {}, stdout: { write: () => true } as never, connectModel: async (_root: string, input: ModelConnectCommand) => { seen.push(input); return result; } };
    await modelsCommand(['models', 'connect', '--scope', 'scope', '--connection', 'codex-cli-subscription', '--model', 'gpt-6.1-sol', '--json'], context);
    expect(seen[0]).toMatchObject({ scopeId: 'scope', connection: 'codex-cli-subscription', model: { nativeId: 'gpt-6.1-sol' } }); expect(seen[0]!.commandId).toMatch(/^connect-[0-9a-f-]{36}$/u);
    for (const [argv, flag] of [[['--model', 'x'], '--connection'], [['--connection', 'openai-api', '--bogus', 'x'], '--bogus']] as const) {
      const error = await modelsCommand(['models', 'connect', '--scope', 'scope', ...argv], context).catch((caught: { code?: string; message?: string }) => caught);
      expect(error).toMatchObject({ code: 'CLI_USAGE' }); expect(String((error as Error).message)).toContain(flag);
    }
  });

  it('Astra R3: a generated command id that waits for approval prints the exact resume command; running it reuses the same id', async () => {
    const seen: ModelConnectCommand[] = [], out: string[] = [];
    const pending = { ...result, status: 'approval-pending', approval: { approvalId: 'ap-1', keyPath: 'provider_invocation_profiles', layer: 'project' } } as unknown as ModelConnectResult;
    const context = { root: '/project', env: {}, stdout: { write: (text: string) => { out.push(text); return true; } } as never, connectModel: async (_root: string, input: ModelConnectCommand) => { seen.push(input); return pending; } };
    await modelsCommand(['models', 'connect', '--scope', 'scope', '--connection', 'openai-api', '--model', 'gpt-6-luna'], context);
    const printed = /(deckent models connect .*--command-id \S+)/u.exec(out.join(''))?.[1];
    expect(printed).toContain(`--command-id ${seen[0]!.commandId}`); expect(out.join('')).toContain('ap-1');
    await modelsCommand(printed!.split(' ').slice(1), context);
    expect(seen).toHaveLength(2); expect(seen[1]).toEqual(seen[0]);
  });

  it('BeUser alpha.56.1 (Ayşe): the person\'s text leads with the model and its state; the reference, key and bookkeeping steps follow', async () => {
    const out: string[] = [];
    await modelsCommand(['models', 'connect', '--scope', 'scope', '--connection', 'local-openai', '--command-id', 'c-3', '--lang', 'tr'], { root: '/project', env: {},
      stdout: { write: (text: string) => { out.push(text); return true; } } as never, connectModel: async () => ({ ...result, models: [{ nativeId: 'Qwen3.8', state: 'connected' }] }) as never });
    const lines = out.join('').trim().split('\n');
    expect(lines[0]).toBe('Qwen3.8: bağlandı ve açık'); expect(lines[1]).toContain('scope kapsamına bağlandı');
    expect(lines.findIndex(line => line.startsWith('Katalog:'))).toBeGreaterThan(1);
  });

  it('S3-3: the CLI kind takes the executable, the login dir and the consent choice into the same command; the result names the login and the consent', async () => {
    const seen: unknown[] = [], out: string[] = [], cli = { ...result, connection: 'claude-cli-subscription', credentialRef: null, keyStored: null, cli: { configDir: '/home/p/.claude', delegate: ['ai'] } };
    const run = (extra: string[]) => modelsCommand(['models', 'connect', '--scope', 'scope', '--connection', 'claude-cli-subscription', '--model', 'vendor-model', '--command-id', 'c-9', ...extra],
      { root: '/project', env: {}, stdout: { write: (text: string) => { out.push(text); return true; } } as never, connectModel: async (_root, input) => { seen.push(input); return cli; } });
    await run(['--executable', '/opt/cli', '--config-dir', '/home/p/.claude', '--delegate', 'ai', '--lang', 'en']);
    await run(['--delegate', 'none', '--json']);
    await run([]);
    const base = { schemaVersion: 1, commandId: 'c-9', scopeId: 'scope', connection: 'claude-cli-subscription', endpoint: null, model: { nativeId: 'vendor-model' } };
    expect(seen).toEqual([{ ...base, cli: { executable: '/opt/cli', configDir: '/home/p/.claude' }, delegate: ['ai'] }, { ...base, delegate: [] }, base]);
    expect(out[0]).toContain('Claude login used: /home/p/.claude'); expect(out[0]).toContain('Besides you, these may use this login after your consent: ai.');
    for (const bad of [['--delegate', 'everyone'], ['--executable', 'relative/cli']]) await expect(run(bad)).rejects.toMatchObject({ code: expect.stringMatching(/^(CLI_USAGE|MODEL_CONNECT_INVALID)$/u) });
    const help: string[] = [];
    await modelsCommand(['models', 'connect', '--help', '--lang', 'tr'], { root: '/p', env: {}, stdout: { write: (text: string) => { help.push(text); return true; } } as never, connectModel: async () => cli });
    expect(help.join('')).toContain('--delegate none|ai|system|ai,system');
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

it('connect help lists current connectable kinds from host data in both languages', async () => {
  for (const locale of ['en', 'tr']) {
    const out: string[] = [], kinds = PROVIDER_CONNECT_KINDS.map(kind => ({ id: kind.id, labelKey: kind.labelKey, available: kind.available, connectFamily: providerConnectFamily(kind) }));
    await modelsCommand(['models', 'connect', '--help', '--lang', locale], { env: {}, stdout: { write: (text: string) => { out.push(text); return true; } } as never,
      providerConnect: { kinds } } as never);
    expect(out.join('')).toContain('openrouter'); expect(out.join('')).toContain('claude-cli-subscription');
    expect(out.join('')).toContain('chatgpt-login'); expect(out.join('')).not.toContain('{kinds}');
    out.length = 0;
    expect(await cliMain(['models', 'connect', '--help', '--lang', locale], { env: {},
      stdout: { write: (text: string) => { out.push(text); return true; } } as never,
      helpParams: async key => key === 'cli.help.modelsConnect' ? { kinds: providerConnectHelpKinds() } : {},
      loadHost: async () => { throw new Error('help must not initialize the host'); } })).toBe(0);
    expect(out.join('')).toContain('openrouter'); expect(out.join('')).toContain('claude-cli-subscription'); expect(out.join('')).toContain('chatgpt-login');
    expect(out.join('')).not.toContain('{kinds}');
  }
});
