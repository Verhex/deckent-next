import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearConfigCache } from '#platform/index.js';
import { assertTerminalChatReady } from '#composition/core/terminal-chat/index.js';
import { runtime } from '../support/chat-turn-harness.js';

// T4 MODEL-SWITCH (owner 2026-10-08, Jev a172b1ad; S19): `/model` pins a model for this session; the next turn carries the exact reference (protocol
// v23) and the service uses exactly it or refuses typed. The configured `terminal.chat.reference` is never used in its place (no silent fallback).
const declared = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
const undeclared = { providerId: 'local-openai', providerVersion: 1, modelId: 'gone', modelVersion: 1 };
type Sent = { model: string };

describe.skipIf(process.platform !== 'linux')('session model pin through the runtime service (v23)', () => {
  it('a pinned model that the catalog does not declare is refused typed and nothing is sent, although the configured model would work', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ content: 'never' }];
    await expect(f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-pin-gone', messages: [{ role: 'user', content: 'hi' }], reference: undeclared },
      () => undefined)).rejects.toMatchObject({ code: 'TERMINAL_CHAT_MODEL_NOT_DECLARED' });
    expect(f.state.requests).toEqual([]);
    // The terminal's local preflight checks the pin too: the configured model being fine does not let an undeclared pin through.
    await expect(assertTerminalChatReady(f.project, { env: f.env }, undeclared)).rejects.toMatchObject({ code: 'TERMINAL_CHAT_MODEL_NOT_DECLARED' });
  }, 30_000);

  it('the pinned model is what the turn uses: with the configured model broken, a pinned declared model still answers', async () => {
    const f = await runtime(); await f.start();
    const path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8')) as { terminal: { chat: { reference: unknown } } };
    config.terminal.chat.reference = undeclared;
    await writeFile(path, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
    f.state.script = [{ content: 'Pinned.' }];
    await expect(f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-unpinned', messages: [{ role: 'user', content: 'hi' }] }, () => undefined))
      .rejects.toMatchObject({ code: 'TERMINAL_CHAT_MODEL_NOT_DECLARED' });
    expect(await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-pinned', messages: [{ role: 'user', content: 'hi' }], reference: declared },
      () => undefined)).toMatchObject({ finish: 'stop', answer: 'Pinned.' });
    expect((f.state.requests as Sent[]).map(request => request.model)).toEqual(['native-chat']);
    // The local preflight agrees: the broken configured model blocks an unpinned turn, never a pinned declared one.
    await expect(assertTerminalChatReady(f.project, { env: f.env })).rejects.toMatchObject({ code: 'TERMINAL_CHAT_MODEL_NOT_DECLARED' });
    await expect(assertTerminalChatReady(f.project, { env: f.env }, declared)).resolves.toBeDefined();
  }, 30_000);

  // PRE-10 OTURUM-MODEL-PIN (owner 2026-10-21): on a fresh installation with no persistent model, a session pin alone runs the turn; the local
  // preflight no longer refuses it as unconfigured, and an unusable pin is refused typed by name without any other model standing in.
  it('with no configured model anywhere, a pinned declared model passes the preflight and answers; an undeclared pin is refused typed, nothing sent', async () => {
    const f = await runtime(); await f.start();
    const path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8')) as { terminal: { chat: { reference?: unknown } } };
    delete config.terminal.chat.reference;
    await writeFile(path, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
    await expect(assertTerminalChatReady(f.project, { env: f.env })).rejects.toMatchObject({ code: 'TERMINAL_CHAT_NOT_CONFIGURED' });
    await expect(assertTerminalChatReady(f.project, { env: f.env }, declared, 'scope')).resolves.toBeDefined();
    f.state.script = [{ content: 'Only pin.' }];
    expect(await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-only-pin', messages: [{ role: 'user', content: 'hi' }], reference: declared },
      () => undefined)).toMatchObject({ finish: 'stop', answer: 'Only pin.' });
    await expect(assertTerminalChatReady(f.project, { env: f.env }, undeclared, 'scope')).rejects.toMatchObject({ code: 'TERMINAL_CHAT_MODEL_NOT_DECLARED' });
    f.state.script = [{ content: 'never' }]; const before = f.state.requests.length;
    await expect(f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-bad-pin', messages: [{ role: 'user', content: 'hi' }], reference: undeclared },
      () => undefined)).rejects.toMatchObject({ code: 'TERMINAL_CHAT_MODEL_NOT_DECLARED', message: expect.stringContaining('local-openai/gone@1') });
    expect(f.state.requests).toHaveLength(before);
  }, 30_000);
});
