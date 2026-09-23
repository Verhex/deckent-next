import { describe, expect, it } from 'vitest';
import { fitStatusRow, renderAssistantStream, renderCompleteReply, startAssistantStream, streamStepEntries, worklineStatusSegments,
  type AssistantStreamState, type AssistantUnit, type TurnDelta } from '#surfaces/core/terminal/index.js';

function play(deltas: ReadonlyArray<readonly [TurnDelta, number]>) {
  let state: AssistantStreamState = startAssistantStream(1_000);
  const units: AssistantUnit[] = [], narrations: Array<ReturnType<typeof renderAssistantStream>['narration']> = [];
  let footer: ReturnType<typeof renderAssistantStream>['footer'] = null;
  for (const [delta, now] of deltas) {
    const step = renderAssistantStream(state, delta, now);
    state = step.state; units.push(...step.staticUnits); narrations.push(step.narration);
    footer ??= step.footer;
  }
  return { state, units, narrations, footer };
}

describe('assistant stream state machine', () => {
  it('narrates reasoning with a token estimate, collapses it into one summary when the answer starts and never prints it', () => {
    const secret = 'PRIVATE CHAIN OF THOUGHT';
    const { units, narrations, footer } = play([
      [{ kind: 'reasoning', text: `${secret} ` }, 1_100],
      [{ kind: 'reasoning', text: 'x'.repeat(15) }, 1_500],
      [{ kind: 'text', text: 'Answer line\npart' }, 3_600],
      [{ kind: 'usage', promptTokens: 12, completionTokens: 34, reasoningTokens: 20 }, 3_700],
      [{ kind: 'done', finish: 'stop' }, 4_000],
    ]);
    expect(narrations[0]).toEqual({ tokens: 7, approximate: true, startedAtMs: 1_100 });
    expect(narrations[1]).toEqual({ tokens: 10, approximate: true, startedAtMs: 1_100 });
    expect(narrations.slice(2)).toEqual([null, null, null]);
    expect(units).toEqual([
      { kind: 'reasoning', tokens: 10, approximate: true, elapsedMs: 2_500 },
      { kind: 'text', markdown: 'Answer line', lead: true },
      { kind: 'text', markdown: 'part', lead: false },
    ]);
    expect(JSON.stringify(units)).not.toContain(secret);
    expect(footer).toEqual({ kind: 'footer', elapsedMs: 3_000, promptTokens: 12, completionTokens: 34, reasoningTokens: 20, finish: 'stop' });
  });

  it('returns only newly finished units per delta and keeps the unfinished tail live', () => {
    let state = startAssistantStream(0);
    let step = renderAssistantStream(state, { kind: 'text', text: '```ts\nconst a' }, 10);
    expect(step.staticUnits).toEqual([]);
    expect(step.liveTail).toEqual({ markdown: '```ts\nconst a', open: 'code' });
    state = step.state;
    step = renderAssistantStream(state, { kind: 'text', text: ' = 1;\n```\n' }, 20);
    expect(step.staticUnits).toEqual([{ kind: 'code', markdown: '```ts\nconst a = 1;\n```', lead: true }]);
    expect(step.liveTail).toEqual({ markdown: '', open: null });
    state = step.state;
    step = renderAssistantStream(state, { kind: 'text', text: 'tail' }, 30);
    expect(step.staticUnits).toEqual([]);
    step = renderAssistantStream(step.state, { kind: 'done', finish: 'length' }, 40);
    expect(step.staticUnits).toEqual([{ kind: 'text', markdown: 'tail', lead: false }]);
    expect(step.footer).toMatchObject({ finish: 'length', elapsedMs: 40, promptTokens: null });
    expect(streamStepEntries(step).map(entry => entry.kind === 'chat' && entry.assistant?.kind)).toEqual(['text', 'footer']);
    const after = renderAssistantStream(step.state, { kind: 'text', text: 'late\n' }, 50);
    expect(after.staticUnits).toEqual([]); expect(after.footer).toBeNull();
  });

  it('flushes an unclosed fence at done and summarises reasoning that produced no answer', () => {
    const unclosed = play([[{ kind: 'text', text: 'x\n```sh\nls\n' }, 10], [{ kind: 'done', finish: 'stop' }, 20]]);
    expect(unclosed.units.map(unit => unit.kind === 'code' || unit.kind === 'text' ? unit.markdown : unit.kind)).toEqual(['x', '```sh\nls']);
    const silent = play([[{ kind: 'reasoning', text: 'abcd' }, 1_000], [{ kind: 'done', finish: 'cancelled' }, 2_000]]);
    expect(silent.units).toEqual([{ kind: 'reasoning', tokens: 1, approximate: true, elapsedMs: 1_000 }]);
    expect(silent.footer?.finish).toBe('cancelled');
  });

  it('adapts a complete non-streaming reply into lead units plus a footer', () => {
    expect(renderCompleteReply('# Hi\n\n| a |\n|---|\n| 1 |', 100, 350)).toEqual([
      { kind: 'text', markdown: '# Hi\n', lead: true },
      { kind: 'table', markdown: '| a |\n|---|\n| 1 |', lead: false },
      { kind: 'footer', elapsedMs: 250, promptTokens: null, completionTokens: null, reasoningTokens: null, finish: 'stop' },
    ]);
  });
});

describe('width-aware status row', () => {
  const labels = { queued: '{count} queued', elapsed: '{seconds}s' };
  const input = { scope: 'company-acme/site-istanbul/project-erp', model: 'local-qwen · vllm', state: 'Working…', busy: true, spinner: '⠋',
    elapsedMs: 12_400, queued: 2, notice: 'service runs another build (restart with /service-restart)', labels };
  const layout = (columns: number) => fitStatusRow(worklineStatusSegments(input), columns, ' · ', '…');
  const text = (columns: number) => layout(columns).segments.map(segment => segment.text).join(' · ');

  it('keeps every fact on a wide terminal', () => {
    expect(layout(160).dropped).toEqual([]);
    expect(text(160)).toBe('company-acme/site-istanbul/project-erp · local-qwen · vllm · ⠋ Working… · 12s · 2 queued · service runs another build (restart with /service-restart)');
  });

  it('drops facts by priority (notice, elapsed, model, queue) and shrinks the scope from the start, never wrapping', () => {
    expect(layout(120).dropped).toEqual(['notice']);
    expect(text(120)).toBe('company-acme/site-istanbul/project-erp · local-qwen · vllm · ⠋ Working… · 12s · 2 queued');
    expect(layout(80).dropped).toEqual(['notice']);
    expect(text(80)).toBe('…cme/site-istanbul/project-erp · local-qwen · vllm · ⠋ Working… · 12s · 2 queued');
    expect(layout(40).dropped).toEqual(['notice', 'elapsed', 'model']);
    expect(text(40)).toBe('…bul/project-erp · ⠋ Working… · 2 queued');
    for (const columns of [40, 80, 120]) expect(text(columns).length).toBeLessThanOrEqual(columns);
  });

  it('keeps the state visible on a tiny terminal', () => {
    expect(text(12)).toContain('⠋');
    expect(text(12).length).toBeLessThanOrEqual(12);
  });
});
