import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { anthropicMessagesBody, anthropicPublishedTariff, parseAnthropicMessagesDefinition } from '#adapters/core/provider-anthropic-messages/index.js';
import { parseOpenAiChatTextRequest } from '#adapters/core/provider-openai-chat/index.js';
import { createOpenRouterPricedNative } from '#adapters/core/provider-openrouter-chat/index.js';
import { fetchOpenRouterTariff, parseOpenRouterTextRequest, type OpenRouterMetadataObservation } from '#adapters/core/provider-openrouter-pricing/index.js';
import { parseModelBindingDefinition } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';
import { createLocalTls } from '../../fixtures/local-tls.js';

// SURROGATE-OPENROUTER 2026-09-30: OpenRouter parses beside parseOpenAiChatTextRequest, so a lone surrogate in a message
// was still serialized as `\ud83d`. Synthetic text only.
const EMOJI = '\u{1F600}';
const lone = (text: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
const loneEscape = (json: string) => /\\u[dD][89abcdefABCDEF][0-9a-fA-F]{2}/.test(json);

const servers: Server[] = [];
let directory = '', certificate = '', privateKey = '';
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'deckent-openrouter-surrogate-'));
  ({ key: privateKey, caPem: certificate } = await createLocalTls(directory));
});
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } });
afterAll(async () => rm(directory, { recursive: true, force: true }));

const metadataPath = '/api/v1/models/vendor/model/endpoints';
const source = () => ({ data: { id: 'vendor/model', endpoints: [{ model_id: 'vendor/model', tag: 'provider/region', provider_name: 'Provider Display',
  context_length: 100, max_prompt_tokens: 10, max_completion_tokens: 4, status: 0, supported_parameters: ['max_completion_tokens'],
  pricing: { prompt: '0.01', completion: '0.02', request: '0', input_cache_read: '0', input_cache_write: '0', internal_reasoning: '0', discount: 0 } }] } });
function profile(origin: string) {
  return { schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope', reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 },
    bindingDigest: 'a'.repeat(64), protocol: { family: 'openrouter-chat-completions', version: 'v1' }, adapter: { id: 'openrouter-chat-http', version: 1,
      definition: { endpoint: `${origin}/chat`, authentication: { type: 'none' }, tls: { caPem: certificate }, maxOutputTokens: 3, metadataEndpoint: `${origin}${metadataPath}`, endpointTag: 'provider/region', metadataLimits: { maxAgeMs: 60_000, maxResponseBytes: 64_000, timeoutMs: 1000 } } },
    allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 2 }, limits: { requestMaxBytes: 8192, responseMaxBytes: 4096, timeoutMs: 500 } };
}
const binding = { encodingVersion: 1, provider: { id: 'provider', version: 1 }, model: { id: 'model', version: 1, nativeId: 'vendor/model',
  protocols: [{ family: 'openrouter-chat-completions', version: 'v1', capabilities: [] }] } };
const clean = { model: 'vendor/model', messages: [{ role: 'user', content: `native text ${EMOJI}` }], max_completion_tokens: 2 };
const poisoned = { model: 'vendor/model', messages: [
  { role: 'user', content: `x \ud83d …[cut: 1471 characters` },
  { role: 'assistant', content: `ok ${EMOJI} a\ude00` },
], max_completion_tokens: 2 };

async function originOf(onPost: (body: string) => void) {
  const server = createServer({ key: privateKey, cert: certificate }, (req, res) => {
    if (req.url === '/api/v1/endpoints/zdr') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ model_id: 'vendor/model', tag: 'provider/region' }] })); return; }
    if (req.url === metadataPath) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(source())); return; }
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { onPost(Buffer.concat(chunks).toString('utf8')); res.end('{}'); });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  return `https://127.0.0.1:${address.port}`;
}
async function observation(origin: string): Promise<OpenRouterMetadataObservation> {
  return fetchOpenRouterTariff({ endpoint: `${origin}${metadataPath}`, modelId: 'vendor/model', endpointTag: 'provider/region',
    maxAgeMs: 100, maxResponseBytes: 64_000, timeoutMs: 500, caPem: certificate }, () => 10);
}
async function posted(request: unknown) {
  let seen = ''; const origin = await originOf(body => { seen = body; });
  const observed = await observation(origin), adapter = createOpenRouterPricedNative({ currentObservation: () => observed, now: () => 10 });
  await adapter.native.send(await adapter.native.prepare(profile(origin), binding, request));
  return seen;
}

it('sends a lone surrogate in user and assistant message content as U+FFFD', async () => {
  const body = await posted(poisoned);
  expect(loneEscape(JSON.stringify(poisoned))).toBe(true);
  expect(loneEscape(body)).toBe(false);
  expect(lone(body)).toBe(false);
  expect(body).toContain('x \uFFFD …[cut: 1471 characters');
  expect(body).toContain(`ok ${EMOJI} a\uFFFD`);
  expect(body).toBe(await posted(poisoned));
});

it('keeps a well-formed request byte-identical, including a paired emoji', async () => {
  const first = await posted(clean), again = await posted(clean);
  expect(loneEscape(first)).toBe(false);
  expect(first).toContain(EMOJI);
  expect(first).not.toContain('tool_calls');
  expect(first).toBe(again);
  expect(first).toBe(WELL_FORMED_BODY);
});

it('hashes the sent body and leaves the command digest on the unsanitized request', async () => {
  let seen = ''; const origin = await originOf(body => { seen = body; });
  const observed = await observation(origin), adapter = createOpenRouterPricedNative({ currentObservation: () => observed, now: () => 10 });
  const command = { schemaVersion: 1 as const, commandId: 'or-surr', scopeId: 'scope',
    reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 }, catalogRevision: 'catalog',
    expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'a'.repeat(64) }, nativeRequest: poisoned };
  const requestDigest = modelInvocationRequestDigest(command);
  const prepared = await adapter.native.prepare(profile(origin), binding, poisoned);
  const quote = adapter.quote({ command, requestDigest, profile: profile(origin), profileDigest: modelInvocationProfileDigest(profile(origin)),
    definition: parseModelBindingDefinition(binding), prepared });
  await adapter.native.send(prepared);
  expect(lone(poisoned.messages[0]!.content)).toBe(true);
  expect(lone(poisoned.messages[1]!.content)).toBe(true);
  expect(modelInvocationRequestDigest(command)).toBe(requestDigest);
  expect(quote.requestDigest).toBe(requestDigest);
  expect(loneEscape(seen)).toBe(false);
  expect(quote.meter.evidence).toMatchObject({ bodyDigest: createHash('sha256').update(seen).digest('hex') });
  expect(loneEscape(JSON.stringify(quote))).toBe(false);
});

it('still refuses assistant tool_calls in an OpenRouter request (contract unchanged)', () => {
  const withTools = { model: 'vendor/model', max_completion_tokens: 2, messages: [{ role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }] };
  expect(() => parseOpenRouterTextRequest(withTools)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
});

it('converts a lone surrogate through the Anthropic wire mapper into well-formed JSON', () => {
  const definition = parseAnthropicMessagesDefinition({ endpoint: 'https://api.anthropic.com/v1/messages', maxOutputTokens: 256,
    authentication: { type: 'header', name: 'x-api-key', credentialRef: 'ANTHROPIC_API_KEY' }, tariff: anthropicPublishedTariff('claude-sonnet-5-5') });
  const native = { model: 'claude-sonnet-5-5', max_completion_tokens: 64, tools: [{ type: 'function', function: { name: 'read_file', description: 'read',
    parameters: { type: 'object', properties: { path: { type: 'string' } } } } }], tool_choice: 'auto' as const, messages: [
    { role: 'user' as const, content: 'x \ud83d tail' },
    { role: 'assistant' as const, content: `ok ${EMOJI}`, tool_calls: [{ id: 'toolu_1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a\ude00"}' } }] },
    { role: 'tool' as const, tool_call_id: 'toolu_1', content: 'body' },
    { role: 'user' as const, content: 'continue' }] };
  const wire = JSON.stringify(anthropicMessagesBody(parseOpenAiChatTextRequest(native, definition), definition, 'scope'));
  expect(loneEscape(JSON.stringify(native))).toBe(true);
  expect(loneEscape(wire)).toBe(false);
  expect(lone(wire)).toBe(false);
  expect(wire).toContain('x \uFFFD tail');
  expect(wire).toContain(`ok ${EMOJI}`);
  expect(wire).toContain('"path":"a\uFFFD"');
});

const WELL_FORMED_BODY = `{"model":"vendor/model","messages":[{"role":"user","content":"native text ${EMOJI}"}],"max_completion_tokens":2,"stream":false,"provider":{"only":["provider/region"],"allow_fallbacks":false,"require_parameters":true,"max_price":{"prompt":"10000","completion":"20000","request":"0"},"order":["provider/region"]}}`;
