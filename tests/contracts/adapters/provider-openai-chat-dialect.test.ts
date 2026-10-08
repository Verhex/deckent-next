import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenAiChatNativePort, createOpenAiChatStream, prepareOpenAiChatHttpRequest } from '#adapters/core/provider-openai-chat/index.js';
import { PROVIDER_CONNECT_KINDS, connectionAdapter, providerConnectKind } from '#adapters/core/provider-connect/index.js';

// T4-B K1 (owner 2026-10-08, Jev d69089cf): the OpenAI chat adapter v5 sends each provider's documented request dialect, carried on the profile
// from the provider-connect registry. Sources (read 2026-10-08): OpenAI chat completions + streaming events (max_completion_tokens,
// stream_options.include_usage); DeepSeek create-chat-completion (max_tokens only; stream_options supported); Z.ai chat-completion + streaming
// guide (max_tokens only; no stream_options, usage on the last chunk; tool_choice auto only). v4 profiles keep the OpenAI wire unchanged.
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const limits = { requestMaxBytes: 65536, responseMaxBytes: 65536, timeoutMs: 5000 };
const tool = { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } };
const request = (extra: Record<string, unknown> = {}) => Object.fromEntries(Object.entries({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 128,
  stream: true, stream_options: { include_usage: true }, tools: [tool], tool_choice: 'auto', ...extra }).filter(([, value]) => value !== undefined));
/** The definition `models connect` writes for a registry kind (its documented dialect). Stage 1: a remote preset now needs a verified price for
 * the exact model, so the wire dialect is built at a loopback address (zero tariff, same kind and dialect); the priced remote path is
 * covered in provider-connect-tariff.test.ts. */
const definitionOf = (kindId: string) => {
  const kind = providerConnectKind(kindId)!;
  return connectionAdapter(kind, { endpoint: `http://127.0.0.1:9${kind.connect!.chatPath}`, credentialRef: null, nativeId: 'm', maxOutputTokens: 4096, currency: 'USD' }).adapter;
};
const bodyOf = (definition: unknown, extra: Record<string, unknown> = {}) => JSON.parse(prepareOpenAiChatHttpRequest(definition, limits, request(extra)).body) as Record<string, unknown>;

describe('OpenAI chat adapter v5: provider dialects', () => {
  it('every openai-chat registry row carries a dialect and is written as v5', () => {
    for (const kind of PROVIDER_CONNECT_KINDS.filter(item => item.connect?.adapter === 'openai-chat-http')) expect(kind.connect!.dialect).toBeDefined();
    expect(definitionOf('openai-api')).toMatchObject({ id: 'openai-chat-http', version: 5 });
  });

  it('OpenAI: max_completion_tokens and stream_options.include_usage, every tool_choice', () => {
    const body = bodyOf(definitionOf('openai-api').definition);
    expect(body).toMatchObject({ max_completion_tokens: 128, stream: true, stream_options: { include_usage: true }, tool_choice: 'auto' });
    expect(body).not.toHaveProperty('max_tokens');
    expect(bodyOf(definitionOf('openai-api').definition, { tool_choice: 'required' })['tool_choice']).toBe('required');
  });

  it('DeepSeek: max_tokens (never max_completion_tokens), stream_options kept', () => {
    const body = bodyOf(definitionOf('deepseek-api').definition);
    expect(body).toMatchObject({ max_tokens: 128, stream: true, stream_options: { include_usage: true } });
    expect(body).not.toHaveProperty('max_completion_tokens');
    // stream_options only with stream: true (DeepSeek answers 400 otherwise).
    const unstreamed = bodyOf(definitionOf('deepseek-api').definition, { stream: false, stream_options: undefined });
    expect(unstreamed).not.toHaveProperty('stream_options'); expect(unstreamed['stream']).toBe(false);
  });

  it('Z.ai GLM (global and China): max_tokens, no stream_options, tool_choice auto only', () => {
    for (const kind of ['zai-api', 'zai-cn-api']) {
      const body = bodyOf(definitionOf(kind).definition);
      expect(body).toMatchObject({ max_tokens: 128, stream: true, tool_choice: 'auto' });
      expect(body).not.toHaveProperty('stream_options'); expect(body).not.toHaveProperty('max_completion_tokens');
      // A tool_choice the provider does not document is refused before anything is sent.
      expect(() => bodyOf(definitionOf(kind).definition, { tool_choice: 'required' })).toThrow(expect.objectContaining({ code: 'OPENAI_CHAT_REQUEST_INVALID' }));
    }
  });

  it('a v4 definition (no dialect) keeps the OpenAI wire unchanged', () => {
    const v4 = { endpoint: 'https://api.example.com/v1/chat/completions', maxOutputTokens: 4096, authentication: { type: 'bearer', credentialRef: 'K' },
      tariff: { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } };
    expect(bodyOf(v4)).toMatchObject({ max_completion_tokens: 128, stream_options: { include_usage: true } });
  });

  it('usage on the last content chunk (Z.ai shape, no separate usage chunk) settles the stream', () => {
    const stream = createOpenAiChatStream({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 64, stream: true,
      stream_options: { include_usage: true } }, limits);
    const event = (body: Record<string, unknown>) => Buffer.from(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'glm-5.3', ...body })}\n\n`);
    stream.push(event({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] }));
    stream.push(event({ choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }));
    stream.push(Buffer.from('data: [DONE]\n\n'));
    const done = stream.finish();
    expect(done).toMatchObject({ response: { usage: { prompt_tokens: 8, completion_tokens: 2 } } });
  });

  it('end to end through the native port: a v5 Z.ai profile sends the dialect body; v4 with a dialect or v5 without one is refused', async () => {
    const seen: Record<string, unknown>[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const parts: Buffer[] = []; req.on('data', part => parts.push(part));
      req.on('end', () => {
        seen.push(JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'glm-5.3', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`);
      });
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
    const zai = providerConnectKind('zai-api')!.connect!.dialect!;
    const definition = { endpoint: `http://127.0.0.1:${address.port}/chat/completions`, maxOutputTokens: 4096, authentication: { type: 'none' }, dialect: zai,
      tariff: { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } };
    const profile = (version: number, def: Record<string, unknown>) => ({ schemaVersion: 1, id: 'p', version: 1, scopeId: 'scope',
      reference: { providerId: 'zai-api', providerVersion: 1, modelId: 'glm-5.3', modelVersion: 1 }, bindingDigest: 'a'.repeat(64),
      protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version, definition: def },
      allocation: { id: 'a', maxCalls: null, maxInFlight: 1 }, limits });
    const binding = { encodingVersion: 1, provider: { id: 'zai-api', version: 1 }, model: { id: 'glm-5.3', version: 1, nativeId: 'glm-5.3',
      protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] } };
    const native = createOpenAiChatNativePort();
    const body = { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 32, stream: true, stream_options: { include_usage: true } };
    const result = await native.send(await native.prepare(profile(5, definition), binding, body));
    expect(result).toMatchObject({ usage: { completion_tokens: 1 } });
    expect(seen[0]).toMatchObject({ model: 'glm-5.3', max_tokens: 32, stream: true }); expect(seen[0]).not.toHaveProperty('stream_options');
    const withoutDialect: Record<string, unknown> = { ...definition }; delete withoutDialect['dialect'];
    await expect(native.prepare(profile(4, definition), binding, body)).rejects.toMatchObject({ code: 'OPENAI_CHAT_DEFINITION_INVALID' });
    await expect(native.prepare(profile(5, withoutDialect), binding, body)).rejects.toMatchObject({ code: 'OPENAI_CHAT_DEFINITION_INVALID' });
    await expect(native.prepare(profile(4, withoutDialect), binding, body)).resolves.toBeDefined();
  });
});
