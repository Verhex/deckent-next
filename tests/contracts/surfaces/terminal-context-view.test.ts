import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_COMPACTION_HIGH_WATER } from '#engine/index.js';
import { CONTEXT_AUTO_SUMMARY_SHARE, contextBreakdown, contextViewLines } from '#surfaces/core/terminal-render/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

const views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });

describe('/context management view (TERM-UX-1 d)', () => {
  it('shows the display constant of the automatic summary equal to the engine rule', () => {
    expect(CONTEXT_AUTO_SUMMARY_SHARE).toBe(AGENT_COMPACTION_HIGH_WATER);
  });

  it('divides the client-visible history by kind and names the largest items', () => {
    const call = { id: 'c', name: 'read_file', argumentsJson: '{"path":"a"}' };
    const parts = contextBreakdown([{ role: 'system', content: 'S'.repeat(100) }, { role: 'user', content: `q\n\n--- attached file a.ts (10 bytes) ---\n${'F'.repeat(200)}` },
      { role: 'assistant', content: 'A'.repeat(50), toolCalls: [call] }, { role: 'tool', toolCallId: 'c', name: 'read_file', content: 'T'.repeat(400) }]);
    expect(parts.system).toBe(100); expect(parts.tools).toBe(400); expect(parts.assistant).toBe(50 + call.argumentsJson.length);
    expect(parts.attachments).toBeGreaterThan(200); expect(parts.user).toBe(1);
    expect(parts.largest.map(item => item.name)).toEqual(['read_file', 'attachments']);
  });

  it('reports fill, the summary threshold and what remains, the last summary, and suggests /clear past the suggestion share', () => {
    const history = [{ role: 'user' as const, content: 'q' }, { role: 'tool' as const, toolCallId: 'c', name: 'read_file', content: 'T'.repeat(900) }];
    const lines = contextViewLines({ measured: { promptTokens: 4_000, windowTokens: 6_000, quality: 'provider-count' }, history,
      compaction: { count: 2, replacedMessages: 7, atMs: 0 }, now: 1, when: () => 'WHEN' });
    const text = lines.join('\n');
    expect(text).toContain('67%');                 // 4000 of 6000
    expect(text).toContain('auto 4500 (75%) · 500 left');
    expect(text).toContain('summaries 2 · last 7 msgs · WHEN');
    expect(text).toContain('read_file (100%)');
    expect(lines.at(-1)).toBe('/clear');
    const calm = contextViewLines({ measured: { promptTokens: 600, windowTokens: 6_000, quality: 'upper-bound' }, history, compaction: null, now: 1, when: () => '' });
    expect(calm.join('\n')).toContain('summaries 0');
    expect(calm.at(-1)).not.toBe('/clear');
  });

  it('runs through the workline: /context after a turn with a measured window, a tool result and a summary', async () => {
    const streamTurn = async function* () {
      yield { kind: 'context' as const, round: 1, promptTokens: 5_000, windowTokens: 6_000, quality: 'provider-count' as const };
      yield { kind: 'compacted' as const, messages: [{ role: 'user' as const, content: 'sum' }], replacedMessages: 9 };
      yield { kind: 'message' as const, message: { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c', name: 'read_file', argumentsJson: '{}' }] } };
      yield { kind: 'message' as const, message: { role: 'tool' as const, toolCallId: 'c', name: 'read_file', content: 'X'.repeat(2_000) } };
      yield { kind: 'message' as const, message: { role: 'assistant' as const, content: 'ok', toolCalls: [] } };
      yield { kind: 'text' as const, text: 'ok' }; yield { kind: 'done' as const, finish: 'stop' as const, note: null };
    };
    const view = mountWorkline({ completeTurn: async () => 'unused', streamTurn: streamTurn as never, historyMessages: 20,
      sessions: { async save() {}, async list() { return []; }, async load() { return null; } } });
    views.push(view);
    await until(() => view.stdout.text.includes('READY'), 'ready');
    view.stdin.write('go\r'); await until(() => view.stdout.text.includes('ok'), 'turn');
    await settle(40);
    view.stdin.write('/context\r');
    await until(() => view.stdout.text.includes('summaries 1 · last 9 msgs'), 'view');
    expect(view.stdout.text).toContain('auto 4500 (75%)');
    expect(view.stdout.text).toContain('read_file (');
    expect(view.stdout.text).toContain('/clear');
  });
});
