import { createElement } from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantLive, fitStatusRow, footerText, openAssistantStream, reasoningPreviewLines, renderAssistantStream, worklineStatusSegments,
  type AssistantRenderLabels, type AssistantStreamStep, type FooterUnit } from '#surfaces/core/terminal-render/index.js';
import { WorklinePaletteProvider, resolveWorklinePalette, type TurnDelta } from '#surfaces/core/terminal/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

// TL-A (D1 + D5 + D6, owner 2026-09-27 night): the silent parts of a turn are visible (summarizing, the model preparing an answer),
// a cancel says which part it stopped, a finished summary survives the cancel, and the reasoning text shows as a dim, sanitized preview.
function play(deltas: ReadonlyArray<readonly [TurnDelta, number]>, startedAtMs = 1_000) {
  let step: AssistantStreamStep = openAssistantStream(startedAtMs);
  const steps: AssistantStreamStep[] = [step];
  for (const [delta, now] of deltas) { step = renderAssistantStream(step.state, delta, now); steps.push(step); }
  return steps;
}
const context = (compacting: boolean): TurnDelta => ({ kind: 'context', promptTokens: 90_000, windowTokens: 131_072, quality: 'provider-count', ...(compacting ? { compacting } : {}) });

describe('turn phases (D1)', () => {
  it('shows the model preparing an answer from the start, summarizing while a compaction runs, and each wait restarts its counter', () => {
    const steps = play([
      [context(true), 1_200],
      [{ kind: 'compacted', replacedMessages: 9, messages: [{ role: 'user', content: 'SUMMARY' }] }, 4_000],
      [{ kind: 'context', promptTokens: 900, windowTokens: 131_072, quality: 'provider-count' }, 4_100],
      [{ kind: 'reasoning', text: 'hmm' }, 5_000],
      [{ kind: 'tool', phase: 'started', callId: 'c1', name: 'read_file', target: 'a.ts', status: null, ms: null }, 6_000],
      [{ kind: 'tool', phase: 'finished', callId: 'c1', name: 'read_file', target: 'a.ts', status: 'ok', ms: 3 }, 6_010],
      [context(false), 6_100],
      [{ kind: 'text', text: 'Answer' }, 7_000],
    ]);
    expect(steps.map(step => step.waiting)).toEqual([
      { kind: 'model', sinceMs: 1_000 },
      { kind: 'compaction', sinceMs: 1_200 },
      // The summary landed: the round is being prepared again, counted from then; a plain measurement does not restart it.
      { kind: 'model', sinceMs: 4_000 }, { kind: 'model', sinceMs: 4_000 },
      // Reasoning has its own narration; a running tool its own line.
      null, null,
      { kind: 'model', sinceMs: 6_010 }, { kind: 'model', sinceMs: 6_010 },
      null,
    ]);
  });

  it('never announces a summary for a measurement that does not expect one', () => {
    const steps = play([[context(false), 1_500]]);
    expect(steps.at(-1)!.waiting).toEqual({ kind: 'model', sinceMs: 1_000 });
  });
});

describe('phase-aware cancel (D5)', () => {
  const footer = (deltas: ReadonlyArray<readonly [TurnDelta, number]>) => play([...deltas, [{ kind: 'done', finish: 'cancelled', note: null }, 9_000]]).at(-1)!.footer!;
  it('names the part of the turn a cancel stopped: the summary, the model answer or a tool call', () => {
    expect(footer([[context(true), 1_200]]).cancelledDuring).toBe('compaction');
    expect(footer([]).cancelledDuring).toBe('model');
    expect(footer([[{ kind: 'reasoning', text: 'x' }, 1_300]]).cancelledDuring).toBe('model');
    expect(footer([[{ kind: 'text', text: 'partial' }, 1_300]]).cancelledDuring).toBe('model');
    expect(footer([[{ kind: 'tool', phase: 'started', callId: 'c', name: 'grep', target: 'x', status: null, ms: null }, 1_300]]).cancelledDuring).toBe('tool');
    // A finished summary is no longer the stopped part.
    expect(footer([[context(true), 1_200], [{ kind: 'compacted', replacedMessages: 2, messages: [{ role: 'user', content: 'S' }] }, 2_000]]).cancelledDuring).toBe('model');
    // Only a cancel carries it.
    expect(play([[{ kind: 'done', finish: 'stop' }, 2_000]]).at(-1)!.footer).not.toHaveProperty('cancelledDuring');
  });

  it('writes the stopped part into the footer, from the catalog when it has the words and in neutral text until then', () => {
    const unit: FooterUnit = { kind: 'footer', elapsedMs: 52_400, promptTokens: null, completionTokens: null, reasoningTokens: null, finish: 'cancelled',
      cancelledDuring: 'compaction' };
    const labels = WORKLINE_TEST_LABELS.render;
    expect(footerText(unit, labels, '·')).toBe('52.4s · cancelled (summarizing)');
    expect(footerText({ ...unit, cancelledDuring: 'model' }, labels, '·')).toBe('52.4s · cancelled (model response)');
    const catalog: AssistantRenderLabels = { ...labels, cancelledDuring: { compaction: 'IPTAL-OZET', model: 'IPTAL-MODEL', tool: 'IPTAL-ARAC' } };
    expect(footerText({ ...unit, cancelledDuring: 'tool' }, catalog, '·')).toBe('52.4s · IPTAL-ARAC');
    const unnamed: FooterUnit = { kind: 'footer', elapsedMs: 52_400, promptTokens: null, completionTokens: null, reasoningTokens: null, finish: 'cancelled' };
    expect(footerText(unnamed, labels, '·')).toBe('52.4s · CANCELLED');
  });

  it('shows the cancel hint in the status row only while a turn can be cancelled, and drops it before the elapsed time', () => {
    const base = { scope: 'scope', state: 'BUSY', labels: { queued: '{count} queued', elapsed: '{seconds}s' } };
    const ids = (input: Parameters<typeof worklineStatusSegments>[0]) => worklineStatusSegments(input).map(segment => segment.id);
    expect(ids({ ...base, busy: true, elapsedMs: 3_000, cancellable: true })).toContain('cancel');
    expect(ids({ ...base, busy: true, elapsedMs: 3_000, cancellable: false })).not.toContain('cancel');
    expect(ids({ ...base, busy: false, cancellable: true })).not.toContain('cancel');
    const text = worklineStatusSegments({ ...base, busy: true, elapsedMs: 3_000, cancellable: true }).find(segment => segment.id === 'cancel')!.text;
    expect(text).toBe('Esc cancels');
    expect(worklineStatusSegments({ ...base, labels: { ...base.labels, cancelHint: 'ESC-IPTAL' }, busy: true, cancellable: true })
      .find(segment => segment.id === 'cancel')!.text).toBe('ESC-IPTAL');
    const narrow = fitStatusRow(worklineStatusSegments({ ...base, busy: true, elapsedMs: 3_000, cancellable: true }), 'scope · BUSY · 3s'.length, ' · ', '…');
    expect(narrow.dropped).toEqual(['cancel']);
  });
});

describe('reasoning preview (D6)', () => {
  it('keeps the last lines of the reasoning, sanitized, and drops them when the answer starts', () => {
    const steps = play([
      [{ kind: 'reasoning', text: 'first line\nsecond ' }, 1_100],
      [{ kind: 'reasoning', text: 'line \u001b[31mred\u001b[0m\n\u001b]0;TITLE\u0007third \u009b2Jline\n' }, 1_200],
      [{ kind: 'text', text: 'Answer' }, 1_300],
    ]);
    expect(steps[1]!.reasoningPreview).toEqual(['first line', 'second']);
    expect(steps[2]!.reasoningPreview).toEqual(['second line red', 'third 2Jline']);
    // No control character of any kind (ESC, BEL, C1 CSI, line breaks) reaches the terminal from the model's text.
    expect(steps[2]!.reasoningPreview.join('').split('').filter(char => char.charCodeAt(0) < 0x20 || (char.charCodeAt(0) >= 0x7f && char.charCodeAt(0) <= 0x9f))).toEqual([]);
    expect(steps[3]!.reasoningPreview).toEqual([]);
    expect(reasoningPreviewLines('a\n\n\nb\n  \n')).toEqual(['a', 'b']);
  });

  it('starts a fresh preview for the next model round after a tool call', () => {
    const steps = play([
      [{ kind: 'reasoning', text: 'round one' }, 1_100],
      [{ kind: 'tool', phase: 'started', callId: 'c', name: 'grep', target: 'x', status: null, ms: null }, 1_200],
      [{ kind: 'tool', phase: 'finished', callId: 'c', name: 'grep', target: 'x', status: 'ok', ms: 1 }, 1_300],
      [{ kind: 'reasoning', text: 'round two' }, 1_400],
    ]);
    expect(steps.map(step => step.reasoningPreview)).toEqual([[], ['round one'], [], [], ['round two']]);
  });
});

class Screen extends Writable {
  text = '';
  readonly isTTY = true; readonly columns = 120; readonly rows = 40;
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.text += chunk.toString('utf8'); done(); }
}
const views: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of views.splice(0)) view.unmount(); });
function live(step: AssistantStreamStep, showReasoning = true) {
  const stdout = new Screen();
  views.push(render(createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(AssistantLive, {
    tail: step.liveTail, narration: step.narration, labels: WORKLINE_TEST_LABELS.render, lead: true, activeTool: step.activeTool, waiting: step.waiting,
    reasoningPreview: showReasoning ? step.reasoningPreview : [] }) }), { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false }));
  return stdout;
}

describe('live region (D1 + D6)', () => {
  it('draws the waiting line with its live seconds, and the reasoning preview under the narration unless it is hidden', async () => {
    const now = Date.now();
    const summarizing = live(play([[context(true), now - 2_300]], now - 3_000).at(-1)!);
    await settle(20);
    expect(summarizing.text).toMatch(/summarizing earlier messages · 2s/u);
    const preparing = live(openAssistantStream(now - 4_200));
    await settle(20);
    expect(preparing.text).toMatch(/model is preparing a response · 4s/u);
    const thinking = play([[{ kind: 'reasoning', text: 'PLAN-A\nPLAN-B' }, now]], now).at(-1)!;
    const shown = live(thinking); await settle(20);
    expect(shown.text).toContain('THINKING'); expect(shown.text).toContain('PLAN-A'); expect(shown.text).toContain('PLAN-B');
    const hidden = live(thinking, false); await settle(20);
    expect(hidden.text).toContain('THINKING'); expect(hidden.text).not.toContain('PLAN-');
  });
});

describe('workline (D5 + D6)', () => {
  const mounted: Array<ReturnType<typeof mountWorkline>> = [];
  afterEach(() => { for (const view of mounted.splice(0)) view.instance.unmount(); });

  it('keeps a finished summary after Esc: the next turn starts from the compacted history, not from the old one', async () => {
    const seen: (readonly { role: string; content: string }[])[] = [];
    const streamTurn = async function* (messages: readonly { role: string; content: string }[], signal: AbortSignal) {
      seen.push(messages);
      if (seen.length > 1) { yield { kind: 'done' as const, finish: 'stop' as const }; return; }
      yield { kind: 'context' as const, promptTokens: 90_000, windowTokens: 131_072, quality: 'provider-count' as const, compacting: true };
      yield { kind: 'compacted' as const, replacedMessages: 3, messages: [{ role: 'user' as const, content: 'SUMMARY' }, { role: 'user' as const, content: 'first' }] };
      yield { kind: 'reasoning' as const, text: 'thinking' };
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { kind: 'done' as const, finish: 'cancelled' as const, note: null };
    };
    const view = mountWorkline({ streamTurn }); mounted.push(view);
    await settle(20); view.stdin.write('first\r');
    await until(() => view.stdout.text.includes('COMPACTED 3'), 'compaction line');
    await until(() => view.stdout.text.includes('Esc cancels'), 'cancel hint while the turn runs');
    view.stdin.write('\u001b');
    await until(() => view.stdout.text.includes('cancelled (model response)'), 'phase-aware cancel footer');
    view.stdin.write('next\r'); await until(() => seen.length === 2, 'second turn');
    expect(seen[1]).toEqual([{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'SUMMARY' }, { role: 'user', content: 'first' },
      { role: 'user', content: 'next' }]);
  });

  it('says a summary stopped halfway was not kept, and the next turn sends the history unchanged', async () => {
    const seen: (readonly { role: string; content: string }[])[] = [];
    const streamTurn = async function* (messages: readonly { role: string; content: string }[], signal: AbortSignal) {
      seen.push(messages);
      if (seen.length > 1) { yield { kind: 'done' as const, finish: 'stop' as const }; return; }
      yield { kind: 'context' as const, promptTokens: 90_000, windowTokens: 131_072, quality: 'provider-count' as const, compacting: true };
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { kind: 'done' as const, finish: 'cancelled' as const, note: null };
    };
    const view = mountWorkline({ streamTurn }); mounted.push(view);
    await settle(20); view.stdin.write('first\r');
    await until(() => view.stdout.text.includes('summarizing earlier messages'), 'summarizing line');
    view.stdin.write('\u001b');
    await until(() => view.stdout.text.includes('cancelled (summarizing)'), 'phase-aware cancel footer');
    expect(view.stdout.text).toContain('Summarizing was cancelled before it finished');
    view.stdin.write('next\r'); await until(() => seen.length === 2, 'second turn');
    expect(seen[1]).toEqual([{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'first' }, { role: 'user', content: 'next' }]);
  });

  it('/reasoning turns the preview off and on; the narration line stays', async () => {
    let turn = 0; const asked: unknown[] = [], sessions: unknown[] = [];
    // v16 (OPEN-REASONING-FILE): the same state asks the turn for no model thinking while off. SCR-A: every turn names the conversation.
    const streamTurn = async function* (_messages: unknown, _signal: AbortSignal, options?: { readonly reasoning?: 'off'; readonly sessionId?: string }) {
      turn++; asked.push(options?.reasoning ? { reasoning: options.reasoning } : null); sessions.push(options?.sessionId);
      yield { kind: 'reasoning' as const, text: `PREVIEW-${turn}` };
      await settle(80);
      yield { kind: 'text' as const, text: `answer-${turn}` }; yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const view = mountWorkline({ streamTurn }); mounted.push(view);
    await settle(20); view.stdin.write('one\r');
    await until(() => view.stdout.text.includes('answer-1'), 'first answer');
    expect(view.stdout.text).toContain('PREVIEW-1');
    view.stdin.write('/reasoning off\r'); await until(() => view.stdout.text.includes('Reasoning off (preview and model thinking)'), 'off notice');
    view.stdin.write('two\r'); await until(() => view.stdout.text.includes('answer-2'), 'second answer');
    expect(view.stdout.text).not.toContain('PREVIEW-2');
    view.stdin.write('/reasoning\r'); await until(() => view.stdout.text.includes('Reasoning on (preview and model thinking)'), 'toggle back on');
    view.stdin.write('three\r'); await until(() => view.stdout.text.includes('answer-3'), 'third answer');
    expect(view.stdout.text).toContain('PREVIEW-3');
    view.stdin.write('/reasoning maybe\r'); await until(() => view.stdout.text.includes('Usage: /reasoning [on|off]'), 'usage');
    expect(asked).toEqual([null, { reasoning: 'off' }, null]);
    expect(new Set(sessions).size).toBe(1); expect(sessions[0]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('applies a /reasoning off typed while a turn runs to the message queued after it (FIFO, no render in between)', async () => {
    const asked: unknown[] = [];
    const streamTurn = async function* (_messages: unknown, _signal: AbortSignal, options?: { readonly reasoning?: 'off' }) {
      asked.push(options?.reasoning ? { reasoning: options.reasoning } : null); await settle(120);
      yield { kind: 'text' as const, text: `answer-${asked.length}` }; yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const view = mountWorkline({ streamTurn }); mounted.push(view);
    await settle(20); view.stdin.write('one\r'); await settle(30);
    view.stdin.write('/reasoning off\r'); await settle(10); view.stdin.write('two\r');
    await until(() => view.stdout.text.includes('answer-2'), 'queued turn answered');
    expect(asked).toEqual([null, { reasoning: 'off' }]);
  });
});
