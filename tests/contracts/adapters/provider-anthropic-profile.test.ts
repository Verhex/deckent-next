import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as anthropic from '#adapters/core/provider-anthropic-messages/index.js';
import { createLocalTls } from '../../fixtures/local-tls.js';

const { ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION, createAnthropicMessagesPricedNative, parseAnthropicMessagesDefinition } = anthropic;

/**
 * The per-model request contract, written down independently of the adapter's registry from the official docs read 2026-09-29
 * (proof ANTHROPIC-PROFILE-2026-09-29/sources): thinking table build-with-claude/thinking L49-66, effort levels build-with-claude/effort
 * frontmatter + L242-245, max output models/<id>/overview. The adapter must send exactly what this table admits and refuse the rest at load.
 */
type Off = 'disabled' | 'between_tools';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const ALL: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EXPECT: Record<string, { adaptive: boolean; enabled: boolean; off: Off | null; offCeiling?: Effort; effort: readonly Effort[] | null; max: number }> = {
  'claude-fable-5-1': { adaptive: true, enabled: false, off: null, effort: ALL, max: 128_000 },
  'claude-fable-5': { adaptive: true, enabled: false, off: null, effort: ALL, max: 128_000 },
  'claude-opus-5-5': { adaptive: true, enabled: false, off: null, effort: ALL, max: 128_000 },
  'claude-opus-5': { adaptive: true, enabled: false, off: 'disabled', offCeiling: 'high', effort: ALL, max: 128_000 },
  'claude-opus-4-8': { adaptive: true, enabled: false, off: 'disabled', effort: ALL, max: 128_000 },
  'claude-opus-4-7': { adaptive: true, enabled: false, off: 'disabled', effort: ALL, max: 128_000 },
  'claude-opus-4-6': { adaptive: true, enabled: true, off: 'disabled', effort: ['low', 'medium', 'high', 'max'], max: 128_000 },
  'claude-opus-4-5-20251101': { adaptive: false, enabled: true, off: 'disabled', effort: ['low', 'medium', 'high'], max: 64_000 },
  'claude-sonnet-5-5': { adaptive: true, enabled: false, off: 'between_tools', offCeiling: 'high', effort: ALL, max: 128_000 },
  'claude-sonnet-5': { adaptive: true, enabled: false, off: 'disabled', effort: ALL, max: 128_000 },
  'claude-sonnet-4-6': { adaptive: true, enabled: true, off: 'disabled', effort: ['low', 'medium', 'high', 'max'], max: 128_000 },
  'claude-sonnet-4-5-20250929': { adaptive: false, enabled: true, off: 'disabled', effort: null, max: 64_000 },
  // HAIKU55-CATALOG, read 2026-10-08 (models/haiku-5-5 overview + whats-new, build-with-claude/effort): adaptive on by default, manual
  // budget_tokens refused, `disabled` only at high effort or below, all five levels (default medium), 128K synchronous output.
  'claude-haiku-5-5': { adaptive: true, enabled: false, off: 'disabled', offCeiling: 'high', effort: ALL, max: 128_000 },
  'claude-haiku-4-5-20251001': { adaptive: false, enabled: true, off: 'disabled', effort: null, max: 64_000 },
};
const UNKNOWN = 'claude-unlisted-9';

let directory = '', caPem = '', endpoint = '', server: HttpsServer;
const bodies: { path: string; body: Record<string, unknown> }[] = [];
const textStream = (model: string) => [
  ['message_start', { message: { id: 'msg_01', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }],
  ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }],
  ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }], ['message_stop', {}],
].map(([type, payload]) => `event: ${type as string}\ndata: ${JSON.stringify({ type, ...(payload as object) })}\n\n`).join('');
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'deckent-anthropic-profile-'));
  const tls = await createLocalTls(directory); caPem = tls.caPem;
  server = createServer({ key: tls.key, cert: tls.caPem }, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', (part: Buffer) => chunks.push(part));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      bodies.push({ path: req.url ?? '', body });
      if (req.url?.endsWith('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 7 })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(textStream(String(body['model'])));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  endpoint = `https://127.0.0.1:${address.port}/v1/messages`;
});
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

const tariff = (modelId: string) => ({ kind: 'anthropic-published', version: 1, currency: 'USD', modelId,
  usdPerMTok: { input: '1', cacheWrite5m: '1.25', cacheWrite1h: '2', cacheRead: '0.1', output: '5' },
  source: { url: 'https://platform.claude.com/docs/en/about-claude/pricing', retrievedAt: '2026-09-29' } });
const definitionOf = (modelId: string, extra: Record<string, unknown> = {}) => ({ endpoint, maxOutputTokens: 4096,
  authentication: { type: 'header', name: 'x-api-key', credentialRef: 'ANTHROPIC_API_KEY' }, tls: { caPem }, tariff: tariff(modelId), ...extra });
const profileOf = (modelId: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope',
  reference: { providerId: 'anthropic', providerVersion: 1, modelId: 'claude', modelVersion: 1 }, bindingDigest: 'a'.repeat(64),
  protocol: { family: 'anthropic-messages', version: '2023-06-01' }, adapter: { id: 'anthropic-messages-http', version: ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION,
    definition: definitionOf(modelId, extra) }, allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 },
  limits: { requestMaxBytes: 65_536, responseMaxBytes: 65_536, timeoutMs: 3000 } });
const bindingOf = (nativeId: string) => ({ encodingVersion: 1, provider: { id: 'anthropic', version: 1 }, model: { id: 'claude', version: 1, nativeId,
  protocols: [{ family: 'anthropic-messages', version: '2023-06-01', capabilities: ['tool-calls', 'token-count', 'chat-template-enable-thinking']
    .map(id => ({ id, version: 1, state: 'supported' })) }] } });
const accepts = (modelId: string, extra: Record<string, unknown>) => { try { parseAnthropicMessagesDefinition(definitionOf(modelId, extra)); return true; } catch { return false; } };

/** Sends one streamed round through the fake HTTPS server and returns the exact body the provider received. */
async function sent(modelId: string, extra: Record<string, unknown> = {}, thinkingOff = false) {
  const priced = createAnthropicMessagesPricedNative({ resolveCredential: async reference => reference === 'ANTHROPIC_API_KEY' ? 'sk-ant-test-profile' : undefined });
  const request = { model: modelId, messages: [{ role: 'user' as const, content: 'hi' }], max_completion_tokens: 2048, stream: true,
    stream_options: { include_usage: true }, ...(thinkingOff ? { chat_template_kwargs: { enable_thinking: false } } : {}) };
  const token = await priced.native.prepare(profileOf(modelId, extra), bindingOf(modelId), request);
  const before = bodies.length, result = await priced.native.send(token);
  expect('kind' in result, `${modelId} round rejected`).toBe(false);
  expect(bodies.length).toBe(before + 1);
  return bodies.at(-1)!.body;
}
const controls = (body: Record<string, unknown>) => ({ thinking: body['thinking'], output_config: body['output_config'] });

it('pins the adapter definition version that carries the per-model contract and lists exactly the documented models', () => {
  expect(ANTHROPIC_MESSAGES_HTTP_ADAPTER_VERSION).toBe(2);
  const registry = (anthropic as Record<string, unknown>)['ANTHROPIC_MODEL_CAPABILITIES'] as readonly { modelId: string }[] | undefined;
  expect(registry?.map(row => row.modelId).sort()).toEqual(Object.keys(EXPECT).sort());
});

describe.each(Object.entries(EXPECT))('%s', (modelId, expected) => {
  it('sends no thinking and no output_config by default', async () => {
    expect(controls(await sent(modelId))).toEqual({ thinking: undefined, output_config: undefined });
  });

  it('admits adaptive and manual thinking only where documented, and sends them verbatim', async () => {
    const adaptive = { thinking: { mode: 'adaptive', display: 'summarized' } }, enabled = { thinking: { mode: 'enabled', budgetTokens: 1024 } };
    expect(accepts(modelId, adaptive)).toBe(expected.adaptive);
    expect(accepts(modelId, enabled)).toBe(expected.enabled);
    if (expected.adaptive) expect(controls(await sent(modelId, adaptive)).thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    if (expected.enabled) expect(controls(await sent(modelId, enabled)).thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  it('admits only the documented off type and sends it bare when reasoning is switched off', async () => {
    for (const off of ['disabled', 'between_tools'] as const) expect(accepts(modelId, { thinking: { mode: 'model-default', off } }), off).toBe(expected.off === off);
    if (expected.off === null) return;
    expect(controls(await sent(modelId, { thinking: { mode: 'model-default', off: expected.off } }, true)).thinking).toEqual({ type: expected.off });
    // An off mode limited to `high` effort or below is refused at load when the configured effort is above it.
    if (expected.offCeiling) {
      expect(accepts(modelId, { thinking: { mode: 'model-default', off: expected.off }, effort: 'xhigh' })).toBe(false);
      expect(accepts(modelId, { thinking: { mode: 'model-default', off: expected.off }, effort: 'max' })).toBe(false);
      expect(accepts(modelId, { thinking: { mode: 'model-default', off: expected.off }, effort: 'high' })).toBe(true);
    }
  });

  it('admits exactly the documented effort levels and sends them as output_config.effort', async () => {
    for (const level of ALL) expect(accepts(modelId, { effort: level }), level).toBe(expected.effort?.includes(level) ?? false);
    const level = expected.effort?.[0];
    if (level) expect(controls(await sent(modelId, { effort: level }))).toEqual({ thinking: undefined, output_config: { effort: level } });
  });

  it('refuses a maxOutputTokens above the model limit', () => {
    expect(accepts(modelId, { maxOutputTokens: expected.max })).toBe(true);
    expect(accepts(modelId, { maxOutputTokens: expected.max + 1 })).toBe(false);
  });
});

it('treats an unlisted model with the safe default: no thinking or effort controls are admitted or sent', async () => {
  expect(controls(await sent(UNKNOWN))).toEqual({ thinking: undefined, output_config: undefined });
  expect(controls(await sent(UNKNOWN, { thinking: { mode: 'model-default' } }))).toEqual({ thinking: undefined, output_config: undefined });
  for (const extra of [{ thinking: { mode: 'adaptive', display: 'omitted' } }, { thinking: { mode: 'enabled', budgetTokens: 1024 } },
    { thinking: { mode: 'model-default', off: 'disabled' } }, { thinking: { mode: 'model-default', off: 'between_tools' } }, { effort: 'high' }]) {
    expect(accepts(UNKNOWN, extra), JSON.stringify(extra)).toBe(false);
  }
  // Without a declared off mode, a reasoning-off round is refused before any call.
  const priced = createAnthropicMessagesPricedNative({ resolveCredential: async () => 'sk-ant-test-profile' });
  await expect(priced.native.prepare(profileOf(UNKNOWN), bindingOf(UNKNOWN), { model: UNKNOWN, messages: [{ role: 'user', content: 'hi' }],
    max_completion_tokens: 64, stream: true, chat_template_kwargs: { enable_thinking: false } })).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_INVALID' });
  expect(accepts(UNKNOWN, { effort: 'turbo' })).toBe(false);
});

it('forwards the configured effort to the token counter, which documents output_config', async () => {
  const priced = createAnthropicMessagesPricedNative({ resolveCredential: async () => 'sk-ant-test-profile' });
  const extra = { effort: 'low', tokenCountEndpoint: endpoint.replace('/v1/messages', '/v1/messages/count_tokens') };
  const token = await priced.native.prepare(profileOf('claude-opus-5-5', extra), bindingOf('claude-opus-5-5'),
    { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 64, stream: true, stream_options: { include_usage: true } });
  await expect(priced.native.measure!(token)).resolves.toEqual({ promptTokens: 7, windowTokens: null });
  expect(bodies.at(-1)).toMatchObject({ path: '/v1/messages/count_tokens', body: { model: 'claude-opus-5-5', output_config: { effort: 'low' } } });
});
