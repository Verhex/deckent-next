import { prepareRuntimeSocket } from '#adapters/core/local-runtime-socket/index.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { streamTerminalAgentTurn } from '#surfaces/core/terminal-turn/index.js';
import { clearConfigCache, DeckentError, ErrorRegistry, loadConfig } from '#platform/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

const roots: string[] = [], mounted: ReturnType<typeof mountWorkline>[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) view.instance.unmount();
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'deckent-input-pressure-')); roots.push(project);
  const options = { env: { HOME: join(project, 'home'), USERPROFILE: join(project, 'home') } };
  await mkdir(join(project, '.deckent'));
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(project, 'data') }, service: { inputMaxBytes: 4096 } }));
  const config = await loadConfig(project, options);
  const endpoint = await prepareRuntimeSocket(config.productLayout); roots.push(join(endpoint, '..'));
  // No service listens: the size refusal must precede a connection attempt.
  return { project, options, client: createConfiguredRuntimeClient(project, options) };
}

it.for(['en', 'tr'] as const)('renders the actual client JSON-byte refusal in %s for Unicode and permits /clear recovery', async (language, context) => {
  if (process.platform !== 'linux') {
    await expect(fixture()).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_UNSUPPORTED' });
    context.skip('LOCAL_RUNTIME_UNSUPPORTED: configured client requires Linux authenticated sockets; refusal verified');
  }
  const f = await fixture(), seen: string[] = [];
  const view = mountWorkline({ errorText: error => {
    expect(error).toBeInstanceOf(DeckentError);
    const typed = error as DeckentError; seen.push(typed.code);
    return `${ErrorRegistry.get(typed.code, language, typed.params)?.message} [${typed.code}]`;
  }, streamTurn: (messages, signal) => streamTerminalAgentTurn({ projectRoot: f.project, scopeId: 'scope', messages, signal, options: f.options }, {
    chatTurn: (_root, command, onEvent, _options, abort) => f.client.chatTurn(command, onEvent, abort),
    cancelChatTurn: async () => undefined,
  }) }); mounted.push(view);
  await settle();
  const content = '漢'.repeat(1_500);
  expect(content.length).toBeLessThan(4096); expect(Buffer.byteLength(content)).toBeGreaterThan(4096);
  view.stdin.write(`\u001b[200~${content}\u001b[201~`); await settle(); view.stdin.write('\r');
  await until(() => view.stdout.text.includes('RUNTIME_CHAT_TURN_TOO_LARGE'), 'JSON byte refusal');
  expect(seen).toEqual(['RUNTIME_CHAT_TURN_TOO_LARGE']);
  expect(view.stdout.text).toContain(language === 'tr' ? 'hiçbir şey gönderilmedi' : 'nothing was sent');
  expect(view.stdout.text).toContain('/clear');
  view.stdin.write('/clear\r'); await until(() => view.stdout.text.includes('NEW-SESSION'), 'new conversation');
  view.stdin.write('small\r');
  // This request now passes the byte guard and reaches the intentionally absent service.
  await until(() => seen.length === 2, 'small next request');
  expect(seen[1]).toBe(process.platform === 'linux' ? 'LOCAL_RUNTIME_UNAVAILABLE' : 'LOCAL_RUNTIME_UNSUPPORTED');
});

it('includes the envelope and JSON escaping in the byte refusal even when content alone fits', async context => {
  if (process.platform !== 'linux') {
    await expect(fixture()).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_UNSUPPORTED' });
    context.skip('LOCAL_RUNTIME_UNSUPPORTED: configured client requires Linux authenticated sockets; refusal verified');
  }
  const f = await fixture();
  const content = '\u0000'.repeat(650);
  expect(Buffer.byteLength(content)).toBeLessThan(4096);
  await expect(f.client.chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'request-pressure',
    messages: [{ role: 'user', content }] }, () => undefined)).rejects.toMatchObject({ code: 'RUNTIME_CHAT_TURN_TOO_LARGE' });
});
