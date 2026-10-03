import { afterEach, describe, expect, it } from 'vitest';
import { mountWorkline, settle, until } from '../support/workline-harness.js';
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

const views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });

describe('/resume through the real workline (TERM-UX-1 b)', () => {
  it('prints the resumed conversation after the notice and sends it with the next turn', async () => {
    const earlier = { sessionId: '11111111-2222-4333-8444-555555555555', updatedAtMs: 0, messages: 2, preview: 'old question' };
    const sent: (readonly { role: string; content: string }[])[] = [];
    const streamTurn = async function* (messages: readonly { role: string; content: string }[]) {
      sent.push(messages); yield { kind: 'text' as const, text: 'fresh' }; yield { kind: 'done' as const, finish: 'stop' as const, note: null };
    };
    const view = mountWorkline({ completeTurn: async () => 'unused', streamTurn: streamTurn as never, historyMessages: 20,
      sessions: { async save() {}, async list() { return [earlier]; }, async load() { return [user('old question'), assistant('OLD-ANSWER-TEXT')]; } } });
    views.push(view);
    await until(() => view.stdout.text.includes('READY'), 'ready');
    view.stdin.write(`/resume ${earlier.sessionId}\r`); await until(() => view.stdout.text.includes('RESUMED 2 11111111'), 'resumed');
    await until(() => view.stdout.text.includes('OLD-ANSWER-TEXT'), 'earlier answer printed');
    await settle(20);
    view.stdin.write('next\r'); await until(() => sent.length === 1, 'turn sent');
    expect(sent[0]!.map(message => message.content)).toEqual(['SYSTEM', 'old question', 'OLD-ANSWER-TEXT', 'next']);
  });
});

// The replay and the /context split recognize the engine's summary message and the composition's attached-file blocks by their text:
// these tests keep that coupling honest (a changed marker would otherwise leak a summary or an attachment body silently).
describe('markers shared with the engine and the mention composition', () => {
  it('a real compaction message replays as one marker and a real attached-file block is neither replayed nor counted as typed text', async () => {
    const { planAgentCompaction, renderAgentCompaction } = await import('#engine/index.js');
    const { attachTerminalMentions } = await import('#composition/core/terminal-chat/index.js');
    const { contextBreakdown } = await import('#surfaces/core/terminal-render/index.js');
    const older = Array.from({ length: 14 }, (_, index) => index % 2 ? assistant(`a${index}`) : user(`u${index}`));
    const plan = planAgentCompaction(older)!;
    const summary = renderAgentCompaction(plan, { objective: 'goal', findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] });
    const excerpt = renderAgentCompaction(plan, null);
    expect(texts(resumedHistoryEntries([summary, excerpt]))).toEqual(['notice:· summary', 'notice:· summary']);
    const attached = await attachTerminalMentions({ projectRoot: '/p', scopeId: 's', text: 'look', paths: ['a.ts'], options: {} }, {
      find: async () => ({ schemaVersion: 1, paths: [], truncated: false, incomplete: false }),
      attach: async () => ({ schemaVersion: 1, path: 'a.ts', status: 'attached', content: 'BODY-OF-A', bytes: 9, totalBytes: 9, truncated: false }) });
    const message = user(attached.content);
    expect(texts(resumedHistoryEntries([message]))).toEqual(['user:look']);
    expect(contextBreakdown([message]).attachments).toBeGreaterThan(9);
  });
});
