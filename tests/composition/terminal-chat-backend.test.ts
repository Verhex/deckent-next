import { describe, expect, it } from 'vitest';
import { resolveTerminalChatBackend } from '#composition/core/terminal-chat/index.js';

describe('terminal chat backend', () => {
  it('defaults to invoke_model', () => {
    expect(resolveTerminalChatBackend({})).toBe('invoke_model');
  });

  it('honors dev inference_http env override', () => {
    expect(resolveTerminalChatBackend({ DECKENT_TERMINAL_CHAT_BACKEND: 'inference_http' })).toBe('inference_http');
  });
});
