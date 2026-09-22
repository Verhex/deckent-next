import { describe, expect, it } from 'vitest';
import { extractOpenAiChatTextFromInvocation } from '#composition/core/terminal-chat/index.js';

describe('terminal chat extract', () => {
  it('reads assistant content from native openai shape', () => {
    const text = extractOpenAiChatTextFromInvocation({
      replayed: false,
      receipt: {} as never,
      contentStatus: 'retained',
      purge: null,
      response: {
        schemaVersion: 1,
        native: { choices: [{ message: { content: '  hello  ' } }] },
        usage: null,
      },
    });
    expect(text).toBe('hello');
  });
});
