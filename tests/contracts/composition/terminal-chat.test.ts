import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { completeTerminalChatTurn, describeTerminalChat, assertTerminalChatReady, type TerminalChatInvocationPorts } from '#composition/core/terminal-chat/index.js';
import { extractOpenAiChatTextFromInvocation } from '#adapters/index.js';
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
    response: { schemaVersion: 1, native: { choices: [{ finish_reason: 'stop', message: { content } }] }, usage: null } } as unknown as ModelInvocationResult;
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
      catalogRevision: 'catalog-7', source: 'project', maxCompletionTokens: 512, historyMessages: 40, tools: 'unknown' });
  });

  it('reports an undeclared model and rejects the removed unmanaged HTTP backend key', async () => {
    const undeclared = await project({ provider_catalog: catalog, terminal: { chat: { schemaVersion: 1, reference: { ...reference, modelId: 'other' }, maxCompletionTokens: 512 } } });
    await expect(describeTerminalChat(undeclared.projectRoot, undeclared.options)).resolves.toMatchObject({ status: 'model-not-declared' });
    const legacy = await project({ terminal: { chat: { schemaVersion: 1, backend: 'inference_http' } } });
    await expect(describeTerminalChat(legacy.projectRoot, legacy.options)).rejects.toBeInstanceOf(ConfigValidationError);
  });
});

describe('terminal chat turn is one governed model invocation', () => {
  it('carries the selected effective cap from config into the chat command and agent preflight', async () => {
    const base = await project({ provider_catalog: catalog, terminal: { scopeId: 'team-a', chat: { schemaVersion: 1, reference } } });
    const binding = await inspectModelBinding(base.projectRoot, reference, base.options);
    for (const selected of [undefined, 32768]) {
      const config = { provider_catalog: catalog, terminal: { scopeId: 'team-a', chat: { schemaVersion: 1, reference, ...(selected ? { maxCompletionTokens: selected } : {}) } },
        provider_invocation_profiles: { schemaVersion: 1, profiles: [{ schemaVersion: 1, id: 'profile', version: 1, scopeId: 'team-a', reference, bindingDigest: binding.binding.digest,
          protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'fixture', version: 1, definition: { maxOutputTokens: 128000, effort: 'low' } },
          allocation: { id: 'allocation', maxCalls: 10, maxInFlight: 2 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } }] } };
      await writeFile(join(base.projectRoot, '.deckent/config.json'), JSON.stringify(config)); clearConfigCache();
      const input = { projectRoot: base.projectRoot, scopeId: 'team-a', messages: [{ role: 'user' as const, content: 'hi' }], options: base.options };
      const plain = ports(async () => reply('ok')); await completeTerminalChatTurn(input, plain.value);
      expect(plain.invoked[0]!.nativeRequest['max_completion_tokens']).toBe(selected ?? 4096);
      expect(await assertTerminalChatReady(base.projectRoot, base.options, reference, 'team-a')).toMatchObject({ completionLimitTokens: selected ?? 4096, outputReserveTokens: selected ?? 4096 });
    }
  });
  it('sends the caller scope, fresh catalog binding and an OpenAI chat request the provider adapter accepts', async () => {
    const f = await project({ provider_catalog: catalog, terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 256 } } });
    const p = ports(async () => reply('  merhaba  '));
    const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hi' }];
    await expect(completeTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 'team-a', messages, options: f.options }, p.value)).resolves.toBe('merhaba');
    const [command] = p.invoked;
    const binding = await inspectModelBinding(f.projectRoot, reference, f.options);
    expect(command).toMatchObject({ schemaVersion: 1, scopeId: 'team-a', reference, catalogRevision: 'catalog-7', expectedBinding: binding.binding });
    const definition = parseOpenAiChatHttpDefinition({ endpoint: 'http://127.0.0.1:18080/v1/chat/completions', maxOutputTokens: 256, authentication: { type: 'none' },
      tariff: { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } });
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
    const truncated = ports(async () => ({ ...reply(''), response: { schemaVersion: 1, native: { choices: [{ finish_reason: 'length',
      message: { content: '', reasoning_content: 'thinking that must not be shown as an answer' } }] }, usage: null } }) as unknown as ModelInvocationResult);
    await expect(completeTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 's', messages: [{ role: 'user', content: 'x' }], options: f.options }, truncated.value))
      .rejects.toMatchObject({ code: 'TERMINAL_CHAT_TRUNCATED', params: { maxCompletionTokens: 8 } });
    const empty = ports(async () => reply('   '));
    await expect(completeTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 's', messages: [{ role: 'user', content: 'x' }], options: f.options }, empty.value))
      .rejects.toMatchObject({ code: 'TERMINAL_CHAT_EMPTY' });
    const cancelled = ports(async () => ({ ...reply(''), receipt: { outcome: { state: 'not-sent', reason: 'cancelled-before-permission' } }, response: null }) as ModelInvocationResult);
    await expect(completeTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 's', messages: [{ role: 'user', content: 'x' }], options: f.options }, cancelled.value))
      .rejects.toMatchObject({ code: 'TERMINAL_CHAT_CANCELLED' });
    expect(cancelled.cancelled).toEqual([]);
    const failing = ports(async () => { throw new DeckentError('MODEL_INVOCATION_UNAVAILABLE', 'down'); });
    await expect(completeTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 's', messages: [{ role: 'user', content: 'x' }], options: f.options }, failing.value))
      .rejects.toMatchObject({ code: 'MODEL_INVOCATION_UNAVAILABLE' });
    expect(failing.invoked).toHaveLength(1); expect(failing.cancelled).toEqual([]);
  });

  it('shows the retained refusal after send permission, even if cancellation was requested', async () => {
    const f = await project({ provider_catalog: catalog, terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 64 } } });
    const adapter = { id: 'native-cli-headless', version: 1 };
    const cases = [
      { body: { code: 'HEADLESS_PREFLIGHT_FAILED' }, state: 'unknown', reason: 'interrupted',
        en: 'The record contains the error code HEADLESS_PREFLIGHT_FAILED. The specific cause could not be determined.',
        tr: 'Kayıtta HEADLESS_PREFLIGHT_FAILED hata kodu var. Hatanın kesin nedeni belirlenemedi.' },
      { body: { schemaVersion: 1, refusal: 'response-limit' }, state: 'rejected', reason: 'response-limit',
        en: 'The subscription CLI reply exceeded an output limit.', tr: "Abonelik CLI'ının yanıtı çıktı sınırını aştı." },
      { body: { schemaVersion: 1, refusal: 'guard', field: '/private/fixture-guard' }, state: 'rejected', reason: 'invalid-response',
        en: 'A safety check refused the subscription CLI result.', tr: "Bir güvenlik denetimi abonelik CLI'ının sonucunu reddetti." },
      { body: { schemaVersion: 1, refusal: 'resource-limit', field: 'cpu-time' }, state: 'rejected', reason: 'response-limit',
        en: 'The isolated process returned a status reserved for the CPU-time limit.', tr: 'Yalıtılmış süreç, CPU süresi sınırına ayrılan çıkış kodunu döndürdü.' },
      { body: { schemaVersion: 4, refusal: 'process-exit', exitCode: 23, signal: null, stderrSummary: '/private/fixture-stderr' }, state: 'unknown', reason: 'interrupted',
        en: 'The launched isolation command exited with code 23.', tr: 'Başlatılan yalıtım komutu 23 koduyla sonlandı.' },
    ] as const;
    const controller = new AbortController();
    controller.abort();
    for (const { body, state, reason, en, tr } of cases) {
      const result = { ...reply(''), response: null, receipt: { claim: { invocationId: 'invocation' }, profile: { adapter },
        outcome: { state, evidence: { adapter, reason } } } } as unknown as ModelInvocationResult;
      const p = ports(async () => result);
      const inspect = async (_root: string, query: unknown) => {
        expect(query).toEqual({ schemaVersion: 2, scopeId: 'team-a', invocationId: 'invocation', reference, includeResponseContent: true });
        return { responseContent: { kind: 'response-body' as const, schemaVersion: 1 as const, descriptor: {} as never,
          data: Buffer.from(JSON.stringify(body)).toString('base64') } };
      };
      const failure = completeTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 'team-a', messages: [{ role: 'user', content: 'hi' }],
        options: f.options, signal: controller.signal }, { ...p.value, inspect });
      await expect(failure).rejects.toBeInstanceOf(DeckentError);
      const error = await failure.catch((error: DeckentError) => error);
      expect.soft((error as DeckentError).localize?.('en').message).toBe(en);
      expect.soft((error as DeckentError).localize?.('tr').message).toBe(tr);
      expect(p.cancelled).toEqual([]);
    }
  });

  it('extracts trimmed assistant content and returns null for non-chat shapes', () => {
    expect(extractOpenAiChatTextFromInvocation(reply('  hello  '))).toBe('hello');
    expect(extractOpenAiChatTextFromInvocation({ response: { native: { output: [] } } } as unknown as ModelInvocationResult)).toBeNull();
  });
});
