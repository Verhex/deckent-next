import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { completeTerminalChatTurn, describeTerminalChat, extractOpenAiChatTextFromInvocation, type TerminalChatInvocationPorts } from '#composition/core/terminal-chat/index.js';
import { inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { modelInvocationRequestDigest, type ModelInvocationResult } from '#engine/index.js';
import { clearConfigCache, ConfigValidationError, DeckentError, resolveGlobalConfigPaths } from '#platform/index.js';
import type { ModelInvocationCancellationCommand, ModelInvocationCommand } from '#domain/index.js';
import { parseOpenAiChatHttpDefinition, parseOpenAiChatTextRequest } from '../../../src/adapters/core/provider-openai-chat/index.js';

const roots: string[] = [];
const reference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
const catalog = { schemaVersion: 1, revision: 'catalog-7', providers: [{ id: 'local-openai', version: 1, models: [{ id: 'chat', version: 1,
  nativeId: 'Qwen3.8-27B-Q4_K_M', protocols: [{ family: 'openai-chat-completions', version: 'v1',
    capabilities: [{ id: 'text', version: 1, state: 'supported' }] }] }] }] };

async function project(config: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-terminal-chat-')); roots.push(root);
  const home = join(root, 'home'), projectRoot = join(root, 'project');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  const projectPath = join(projectRoot, '.deckent', 'config.json');
  await Promise.all([mkdir(dirname(resolveGlobalConfigPaths(env).platformPath), { recursive: true }), mkdir(dirname(projectPath), { recursive: true })]);
  await writeFile(projectPath, JSON.stringify(config));
  return { projectRoot, options: { env } };
}

function reply(content: string): ModelInvocationResult {
  return { replayed: false, receipt: {} as never, contentStatus: 'retained', purge: null,
    response: { schemaVersion: 1, native: { choices: [{ message: { content } }] }, usage: null } } as unknown as ModelInvocationResult;
}

function ports(result: (command: ModelInvocationCommand, signal?: AbortSignal) => Promise<ModelInvocationResult>) {
  const invoked: ModelInvocationCommand[] = [], cancelled: ModelInvocationCancellationCommand[] = [];
  const value: TerminalChatInvocationPorts = {
    async invoke(_root, command, _options, signal) { invoked.push(command); return result(command, signal); },
    async cancel(_root, command) { cancelled.push(command); return {}; },
  };
  return { value, invoked, cancelled };
}

afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('terminal chat configuration through the real config loader', () => {
  it('reports not-configured without a terminal section and ready for a declared catalog model', async () => {
    const empty = await project({});
    await expect(describeTerminalChat(empty.projectRoot, empty.options)).resolves.toMatchObject({ status: 'not-configured', reference: null });
    const ready = await project({ provider_catalog: catalog, terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 512 } } });
    await expect(describeTerminalChat(ready.projectRoot, ready.options)).resolves.toEqual({ schemaVersion: 1, status: 'ready', reference,
      catalogRevision: 'catalog-7', maxCompletionTokens: 512, historyMessages: 40 });
  });

  it('reports an undeclared model and rejects the removed unmanaged HTTP backend key', async () => {
    const undeclared = await project({ provider_catalog: catalog, terminal: { chat: { schemaVersion: 1, reference: { ...reference, modelId: 'other' }, maxCompletionTokens: 512 } } });
    await expect(describeTerminalChat(undeclared.projectRoot, undeclared.options)).resolves.toMatchObject({ status: 'model-not-declared' });
    const legacy = await project({ terminal: { chat: { schemaVersion: 1, backend: 'inference_http' } } });
    await expect(describeTerminalChat(legacy.projectRoot, legacy.options)).rejects.toBeInstanceOf(ConfigValidationError);
  });
});

describe('terminal chat turn is one governed model invocation', () => {
  it('sends the caller scope, fresh catalog binding and an OpenAI chat request the provider adapter accepts', async () => {
    const f = await project({ provider_catalog: catalog, terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 256 } } });
    const p = ports(async () => reply('  merhaba  '));
    const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hi' }];
    await expect(completeTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 'team-a', messages, options: f.options }, p.value)).resolves.toBe('merhaba');
    const [command] = p.invoked;
    const binding = await inspectModelBinding(f.projectRoot, reference, f.options);
    expect(command).toMatchObject({ schemaVersion: 1, scopeId: 'team-a', reference, catalogRevision: 'catalog-7', expectedBinding: binding.binding });
    const definition = parseOpenAiChatHttpDefinition({ endpoint: 'http://127.0.0.1:18080/v1/chat/completions', maxOutputTokens: 256, authentication: { type: 'none' } });
    expect(parseOpenAiChatTextRequest(command!.nativeRequest, definition)).toEqual({ model: 'Qwen3.8-27B-Q4_K_M', messages, max_completion_tokens: 256, stream: false });
    // Negative proof for the pre-integration request body, which also carried `max_tokens`.
    expect(() => parseOpenAiChatTextRequest({ ...command!.nativeRequest, max_tokens: 256 }, definition)).toThrow('OPENAI_CHAT_REQUEST_INVALID');
    expect(p.cancelled).toEqual([]);
  });

  it('requests cancellation of the exact invocation when the turn is aborted', async () => {
    const f = await project({ provider_catalog: catalog, terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 64 } } });
    const controller = new AbortController();
    const p = ports((_command, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('client wait aborted')), { once: true });
      controller.abort();
    }));
    const failure = await completeTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 'team-a', messages: [{ role: 'user', content: 'long' }],
      options: f.options, signal: controller.signal }, p.value).catch(error => error);
    expect(failure).toBeInstanceOf(DeckentError); expect(failure.code).toBe('TERMINAL_CHAT_CANCELLED');
    expect(p.cancelled).toEqual([expect.objectContaining({ scopeId: 'team-a', targetCommandId: p.invoked[0]!.commandId, reference,
      expectedRequestDigest: modelInvocationRequestDigest(p.invoked[0]!) })]);
  });

  it('fails typed without configuration, with an undeclared model, with empty text, and never retries', async () => {
    const none = await project({});
    const p = ports(async () => reply('unused'));
    await expect(completeTerminalChatTurn({ projectRoot: none.projectRoot, scopeId: 's', messages: [], options: none.options }, p.value))
      .rejects.toMatchObject({ code: 'TERMINAL_CHAT_NOT_CONFIGURED' });
    const undeclared = await project({ terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 8 } } });
    await expect(completeTerminalChatTurn({ projectRoot: undeclared.projectRoot, scopeId: 's', messages: [], options: undeclared.options }, p.value))
      .rejects.toMatchObject({ code: 'TERMINAL_CHAT_MODEL_NOT_DECLARED' });
    expect(p.invoked).toEqual([]);
    const f = await project({ provider_catalog: catalog, terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 8 } } });
    const empty = ports(async () => reply('   '));
    await expect(completeTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 's', messages: [{ role: 'user', content: 'x' }], options: f.options }, empty.value))
      .rejects.toMatchObject({ code: 'TERMINAL_CHAT_EMPTY' });
    const failing = ports(async () => { throw new DeckentError('MODEL_INVOCATION_UNAVAILABLE', 'down'); });
    await expect(completeTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 's', messages: [{ role: 'user', content: 'x' }], options: f.options }, failing.value))
      .rejects.toMatchObject({ code: 'MODEL_INVOCATION_UNAVAILABLE' });
    expect(failing.invoked).toHaveLength(1); expect(failing.cancelled).toEqual([]);
  });

  it('extracts trimmed assistant content and returns null for non-chat shapes', () => {
    expect(extractOpenAiChatTextFromInvocation(reply('  hello  '))).toBe('hello');
    expect(extractOpenAiChatTextFromInvocation({ response: { native: { output: [] } } } as unknown as ModelInvocationResult)).toBeNull();
  });
});
