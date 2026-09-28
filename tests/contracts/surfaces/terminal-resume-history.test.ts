import { describe, expect, it } from 'vitest';
import { resumedHistoryEntries, RESUME_SHOWN_MESSAGES, RESUME_USER_TEXT_CHARS } from '#surfaces/core/terminal/index.js';

const user = (content: string) => ({ role: 'user' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content, toolCalls: [] });
const tool = (content: string) => ({ role: 'tool' as const, toolCallId: 'c', name: 'read_file', content });
const texts = (rows: ReturnType<typeof resumedHistoryEntries>) => rows.map(row => row.kind === 'chat' ? `${row.role}:${row.text}` : row.kind === 'notice' ? `notice:${row.text}` : row.kind);

describe('resumed conversation replay (TERM-UX-1 b)', () => {
  it('replays user and assistant text in order and folds tool results into one count line', () => {
    const rows = resumedHistoryEntries([user('hello'), assistant(''), tool('a'), tool('b'), assistant('done')]);
    expect(texts(rows)).toEqual(['user:hello', 'notice:· 2 tool', 'assistant:done']);
  });
  it('does not replay attached file bodies or unbounded pastes, and marks a compaction summary', () => {
    const rows = resumedHistoryEntries([user(`read this\n\n--- attached file a.ts (3 bytes) ---\nSECRET-BODY\n--- end of a.ts ---`),
      user('x'.repeat(RESUME_USER_TEXT_CHARS + 50)), user('[Deckent context summary: replaces 4 earlier messages. ...]')]);
    const shown = texts(rows);
    expect(shown[0]).toBe('user:read this');
    expect(shown[1]!.length).toBeLessThan(RESUME_USER_TEXT_CHARS + 20);
    expect(shown[2]).toBe('notice:· summary');
    expect(shown.join('\n')).not.toContain('SECRET-BODY');
  });
  it('shows only the newest bounded part and says how much was left out', () => {
    const many = Array.from({ length: RESUME_SHOWN_MESSAGES + 6 }, (_, index) => index % 2 ? assistant(`a${index}`) : user(`u${index}`));
    const rows = texts(resumedHistoryEntries(many));
    expect(rows[0]).toBe('notice:… 6');
    expect(rows).toHaveLength(RESUME_SHOWN_MESSAGES + 1);
    expect(rows.at(-1)).toBe(`assistant:a${RESUME_SHOWN_MESSAGES + 5}`);
  });
  it('uses catalog templates when provided', () => {
    const rows = texts(resumedHistoryEntries([user('q'), tool('r')], { omitted: 'O{count}', toolResults: 'T{count}', summarized: 'S' }));
    expect(rows).toEqual(['user:q', 'notice:T1']);
  });
});
