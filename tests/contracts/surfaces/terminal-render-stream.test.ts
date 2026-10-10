import { describe, expect, it } from 'vitest';
import { snapshotKnownSecrets } from '#platform/index.js';
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

  // Astra 2124 durable marker (CLEANUP-MARK): a finished tool delta's `cleanup` rides the resulting unit unchanged; absent stays absent.
  it("carries a finished tool delta's cleanup onto the unit, and leaves it off when the delta has none", () => {
    // The finished delta itself carries the resolved target (agent-stream.ts fills it from the started phase); the pure state
    // machine reads it directly off the finished delta, not off its own earlier `started` phase.
    const withCleanup = play([[{ kind: 'tool', phase: 'started', callId: 'c1', name: 'run_shell', target: 'sleep 5 & echo', status: null, ms: null }, 0],
      [{ kind: 'tool', phase: 'finished', callId: 'c1', name: 'run_shell', target: 'sleep 5 & echo', status: 'ok', ms: 20, cleanup: 'group-ended' }, 20]]);
    expect(withCleanup.units).toEqual([{ kind: 'tool', name: 'run_shell', target: 'sleep 5 & echo', status: 'ok', ms: 20, cleanup: 'group-ended' }]);
    const withoutCleanup = play([[{ kind: 'tool', phase: 'started', callId: 'c2', name: 'read_file', target: 'a.ts', status: null, ms: null }, 0],
      [{ kind: 'tool', phase: 'finished', callId: 'c2', name: 'read_file', target: 'a.ts', status: 'ok', ms: 5 }, 5]]);
    expect(withoutCleanup.units).toEqual([{ kind: 'tool', name: 'read_file', target: 'a.ts', status: 'ok', ms: 5 }]);
    expect(withoutCleanup.units[0]).not.toHaveProperty('cleanup');
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

// W12: assertions inspect each emitted step, including dynamic previews, before the complete value exists.
describe('record redaction before stream segmentation and preview cuts', () => {
  const value = 'w12-Fictitious.Q7x8Y9z0', multiline = 'W12-first-line\nsecond-line-012345';
  const known = snapshotKnownSecrets([{ name: 'W12', value }, { name: 'LINES', value: multiline }]);
  const noFragments = (text: string, source: string) => {
    for (const line of source.split('\n')) for (let at = 0; at + 5 <= line.length; at++) expect(text).not.toContain(line.slice(at, at + 5));
  };
  it.each([value, multiline, value.slice(0, 10)+'\n'+value.slice(10)])('protects live and Static answer units at every delta boundary: %s', source => {
    let state = startAssistantStream(0, known);
    const units: AssistantUnit[] = [];
    for (const char of `visible ${source} after\n`) {
      const step = renderAssistantStream(state, { kind: 'text', text: char }, 1); state = step.state; units.push(...step.staticUnits);
      noFragments(JSON.stringify({ units, tail: step.liveTail }), source);
    }
    const done = renderAssistantStream(state, { kind: 'done', finish: 'stop' }, 2); units.push(...done.staticUnits);
    noFragments(JSON.stringify(units), source); expect(JSON.stringify(units)).toContain(source === multiline ? '‹secret:LINES›' : '‹secret:W12›');
  });
  it('protects reasoning and tool output before the bounded tail loses credential context, and resets for another call', () => {
    let state = startAssistantStream(0, known);
    for (const char of value) {
      const step = renderAssistantStream(state, { kind: 'reasoning', text: char }, 1); state = step.state;
      noFragments(step.reasoningPreview.join('\n'), value);
    }
    state = renderAssistantStream(state, { kind: 'tool', phase: 'started', callId: 'c1', name: 'run_shell', target: null, status: null, ms: null }, 2).state;
    for (const delta of [{ kind: 'output', callId: 'c1', stream: 'stdout', text: value.slice(0, 10) },
      { kind: 'output', callId: 'c1', stream: 'stderr', text: 'plain diagnostic\n' }, { kind: 'output', callId: 'c1', stream: 'stdout', text: value.slice(10)+' ' }] as const) {
      const next = renderAssistantStream(state, delta, 3); state = next.state; noFragments(next.activeTool?.output ?? '', value);
    }
    for (const text of [...value, ' ', 'sk-'+ 'q'.repeat(5000), ' tail']) {
      const step = renderAssistantStream(state, { kind: 'output', callId: 'c1', stream: 'stdout', text }, 3); state = step.state;
      noFragments(step.activeTool?.output ?? '', value); expect(step.activeTool?.output ?? '').not.toContain('qqqqq');
    }
    state = renderAssistantStream(state, { kind: 'tool', phase: 'finished', callId: 'c1', name: 'run_shell', target: null, status: 'ok', ms: 1 }, 4).state;
    state = renderAssistantStream(state, { kind: 'tool', phase: 'started', callId: 'c2', name: 'run_shell', target: null, status: null, ms: null }, 5).state;
    expect(renderAssistantStream(state, { kind: 'output', callId: 'c2', stream: 'stdout', text: 'plain output' }, 6).activeTool?.output).toBe('plain output');
  });
});
