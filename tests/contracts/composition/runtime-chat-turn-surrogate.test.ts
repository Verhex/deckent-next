import { describe, expect, it } from 'vitest';
import type { AgentTurnMessage, AgentTurnStreamEvent } from '#domain/index.js';
import { runtime } from '../support/chat-turn-harness.js';

// SURROGATE-CUT (live 2026-09-30 15:05): after a compaction every round was rejected in 0.2 s with HTTP 400 "TextEncodeInput must be
// Union[...]": the compaction cut a tool call's arguments at 200 code units inside an emoji, the persisted summary kept the lone high
// surrogate, JSON sent it as `\ud83d` and the served tokenizer refused the whole request. Synthetic text only.
const EMOJI = '\u{1F600}';
/** JSON escapes only a lone surrogate (a pair is written as UTF-8), so any `\ud800`–`\udfff` escape in a body is a lone half. */
const LONE_ESCAPE = /\\u[dD][89abcdefABCDEF][0-9a-fA-F]{2}/;
const lone = (text: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
type Sent = { messages: { role: string; content: string }[] };

describe.skipIf(process.platform !== 'linux')('well-formed model text through the runtime service (SURROGATE-CUT)', () => {
  it('a compaction whose cut falls inside an emoji persists and sends no lone surrogate (the owner-observed producer)', async () => {
    // Tool call arguments of 1471 code units whose emoji starts at index 199 (the 200 cut of "Earlier tool calls" falls inside it).
    const head = '{"path":"a.md","content":"', argumentsJson = `${head}${'a'.repeat(199 - head.length)}${EMOJI}${'b'.repeat(1471 - 201 - 2)}"}`;
    expect(argumentsJson).toHaveLength(1471);
    const history: AgentTurnMessage[] = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'write a.md' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'write_file', argumentsJson }] },
      { role: 'tool', toolCallId: 'call_0', name: 'write_file', content: `wrote ${EMOJI}` },
      ...Array.from({ length: 14 }, (_, i): AgentTurnMessage => i % 2 ? { role: 'assistant', content: `answer ${i}`, toolCalls: [] } : { role: 'user', content: `q ${i}` }),
      { role: 'user', content: 'continue' }];
    const f = await runtime({ tokenize: true, windowTokens: 100_000, count: body => body.messages.length > 12 ? 90_000 : 900 }); await f.start();
    // The summary answer is unreadable: Deckent writes the mechanical excerpt with the tool calls it recorded (the owner's shape).
    f.state.script = [{ summary: 'not json' }, { content: 'Continued.' }];
    const events: AgentTurnStreamEvent[] = [];
    expect(await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-cut', messages: history }, event => events.push(event)))
      .toMatchObject({ finish: 'stop', answer: 'Continued.' });
    const compacted = events.flatMap(event => event.kind === 'compacted' ? event.messages : []);
    // TERMINAL-S03: the render header (context render and carry versions) leads; the excerpt label follows on the next line.
    const excerpt = compacted.find(message => /^\[Deckent context render v\d+; carry v\d+; [^\n]*\]\n\[Deckent context excerpt: /u.test(message.content))!.content;
    expect(excerpt).toMatch(new RegExp(`- write_file ${head.replace(/[{"}.]/g, '\\$&')}a+ …\\[cut: 1471 characters, sha256 [a-f0-9]{16}\\]`));
    expect(lone(excerpt)).toBe(false);
    const round = f.state.raw.at(-1)!;
    expect(round).not.toMatch(LONE_ESCAPE);
    expect((JSON.parse(round) as Sent).messages.some(message => message.content.includes('…[cut: 1471 characters'))).toBe(true);
  }, 30_000);

  it('an already poisoned history (persisted before the fix) is sent well-formed and the round answers', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ content: 'Answered.' }];
    const poisoned = `[Deckent context excerpt: replaces 116 earlier messages.]\n\nEarlier tool calls (recorded by Deckent):\n- write_file {"content":"x ${'\ud83d'} …[cut: 1471 characters, sha256 0123456789abcdef]`;
    expect(await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-lone', messages: [{ role: 'user', content: poisoned },
      { role: 'user', content: `continue ${EMOJI}` }] }, () => undefined)).toMatchObject({ finish: 'stop', answer: 'Answered.', note: null });
    expect(f.state.raw).toHaveLength(1);
    expect(f.state.raw[0]).not.toMatch(LONE_ESCAPE);
    expect(f.state.raw[0]).toContain('x \uFFFD …[cut: 1471 characters');
    expect(f.state.raw[0]).toContain(`continue ${EMOJI}`);
  }, 30_000);

  it('names a provider rejection by its HTTP status in the turn note, never by its body', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ status: 400 }];
    const result = await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-rejected', messages: [{ role: 'user', content: 'hi' }] }, () => undefined);
    expect(result.finish).toBe('error');
    // W9-PROVIDERS maps HTTP 400 through the bounded diagnostic catalog; PROVIDER-ERRORS names the provider neutrally (not the OpenAI protocol)
    // and an unrecognized provider body remains unavailable.
    expect(result.note).toContain('The provider rejected the request (HTTP 400); the provider message is unavailable.');
    expect(result.note).not.toContain('OpenAI');
    expect(result.note).not.toContain('Switch to the current protocol');
    expect(result.note).not.toContain('TextEncodeInput');
  }, 30_000);
});
