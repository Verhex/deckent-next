import { afterEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { openAiChatPromptUpperBound } from '#adapters/core/provider-openai-chat/index.js';

const asset = { schemaVersion: 1, retrievedAt: '2026-10-03',
  sources: { tokenCounting: 'https://developers.openai.com/api/docs/guides/token-counting' },
  note: 'Adapter-owned estimate policy, not a vendor token guarantee.',
  tokenEstimate: { requestOverheadTokens: 64, messageOverheadTokens: 16, toolOverheadTokens: 32 } };
const assetPath = '#adapters/core/provider-openai-chat/internal/metering.json';
afterEach(() => { vi.doUnmock(assetPath); vi.resetModules(); });
async function load(input: unknown) {
  vi.resetModules();
  vi.doMock(assetPath, () => ({ default: input }));
  return import('#adapters/core/provider-openai-chat/index.js');
}

it('keeps shipped prompt reservation estimates exact for empty, multilingual and tool requests', () => {
  for (const request of [{}, { messages: [{ role: 'user', content: 'Türkçe 🧭' }] },
    { messages: [{ role: 'user', content: 'read a.ts' }, { role: 'tool', content: 'ok', tool_call_id: 'c1' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] }]) {
    const messages = 'messages' in request ? request.messages : [], tools = 'tools' in request ? request.tools : [];
    const legacy = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') + 64 + 16 * messages.length + 32 * tools.length;
    expect(openAiChatPromptUpperBound(request)).toBe(legacy);
  }
});

it('refuses missing parameters, old versions and malformed registry metadata with a typed load error', async () => {
  for (const key of Object.keys(asset.tokenEstimate)) {
    const input = structuredClone(asset);
    delete (input.tokenEstimate as Record<string, number>)[key];
    await expect(load(input)).rejects.toBeInstanceOf(ZodError);
  }
  for (const input of [{ ...asset, tokenEstimate: undefined }, { ...asset, schemaVersion: 0 },
    { ...asset, retrievedAt: undefined }, { ...asset, sources: {} }, { ...asset, sources: { tokenCounting: 'http://example.com' } },
    { ...asset, tokenEstimate: { ...asset.tokenEstimate, unexpected: 1 } }]) {
    await expect(load(input)).rejects.toBeInstanceOf(ZodError);
  }
});

it('requires every token coefficient to be a positive safe integer before adapter load', async () => {
  for (const key of Object.keys(asset.tokenEstimate)) {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '16']) {
      await expect(load({ ...asset, tokenEstimate: { ...asset.tokenEstimate, [key]: value } })).rejects.toBeInstanceOf(ZodError);
    }
  }
});

it('reads every coefficient from the registry asset at module load', async () => {
  const provider = await load({ ...asset,
    tokenEstimate: { requestOverheadTokens: 71, messageOverheadTokens: 19, toolOverheadTokens: 37 } });
  for (const request of [{ messages: [], tools: [] }, { messages: [{ role: 'user', content: 'hello' }], tools: [] },
    { messages: [], tools: [{ type: 'function' }] },
    { messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'yes' }], tools: [{ type: 'function' }, { type: 'function' }] }]) {
    expect(provider.openAiChatPromptUpperBound(request)).toBe(Buffer.byteLength(JSON.stringify(request), 'utf8')
      + 71 + 19 * request.messages.length + 37 * request.tools.length);
  }
});
