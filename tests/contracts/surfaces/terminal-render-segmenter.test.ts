import { describe, expect, it } from 'vitest';
import { EMPTY_SEGMENTER, FENCE_CHUNK_LINES, feedSegmenter, flushSegmenter, segmenterTail, type Segment, type SegmenterState } from '#surfaces/core/terminal/index.js';

/** Feeds chunks in order and collects every finished unit, like the workline appending to `Static`. */
function run(chunks: readonly string[], flush = true): { segments: Segment[]; state: SegmenterState; perChunk: number[] } {
  let state = EMPTY_SEGMENTER;
  const segments: Segment[] = [], perChunk: number[] = [];
  for (const chunk of chunks) {
    const step = feedSegmenter(state, chunk);
    state = step.state; segments.push(...step.segments); perChunk.push(step.segments.length);
  }
  if (flush) { const step = flushSegmenter(state); state = step.state; segments.push(...step.segments); }
  return { segments, state, perChunk };
}

describe('terminal stream segmenter (finished units for Static)', () => {
  it('emits a prose line only once its newline arrives and keeps the partial line in the live tail', () => {
    let state = EMPTY_SEGMENTER;
    let step = feedSegmenter(state, 'Merhaba dü');
    expect(step.segments).toEqual([]);
    expect(segmenterTail(step.state)).toEqual({ markdown: 'Merhaba dü', open: null });
    state = step.state;
    step = feedSegmenter(state, 'nya\nikinci');
    expect(step.segments).toEqual([{ kind: 'text', markdown: 'Merhaba dünya' }]);
    expect(segmenterTail(step.state).markdown).toBe('ikinci');
    expect(flushSegmenter(step.state).segments).toEqual([{ kind: 'text', markdown: 'ikinci' }]);
  });

  it('coalesces lines finished by one chunk, drops leading and repeated blank lines, and normalizes CRLF', () => {
    const { segments } = run(['\n\nA\r\n\n\n\nB\n- item\n', '> quote\n']);
    expect(segments).toEqual([{ kind: 'text', markdown: 'A\n\nB\n- item' }, { kind: 'text', markdown: '> quote' }]);
  });

  it('holds a fenced code block split across deltas and emits it whole on its closing fence', () => {
    const { segments, perChunk } = run(['Before\n``', '`ts\nconst a', ' = 1;\n', 'const b = 2;\n`', '``\nAfter\n']);
    expect(segments).toEqual([
      { kind: 'text', markdown: 'Before' },
      { kind: 'code', markdown: '```ts\nconst a = 1;\nconst b = 2;\n```' },
      { kind: 'text', markdown: 'After' },
    ]);
    expect(perChunk).toEqual([1, 0, 0, 0, 2]);
  });

  it('shows an unclosed fence live and flushes it on done instead of freezing the answer', () => {
    const { state, segments } = run(['```py\nprint(1)\nprint(2)\npri'], false);
    expect(segments).toEqual([]);
    expect(segmenterTail(state)).toEqual({ markdown: '```py\nprint(1)\nprint(2)\npri', open: 'code' });
    const flushed = flushSegmenter(state);
    expect(flushed.segments).toEqual([{ kind: 'code', markdown: '```py\nprint(1)\nprint(2)\npri' }]);
    expect(segmenterTail(flushed.state)).toEqual({ markdown: '', open: null });
  });

  it('chunks a runaway fence into scrollback but stays in code mode so the real closing fence still closes it', () => {
    const body = Array.from({ length: FENCE_CHUNK_LINES + 5 }, (_, index) => `line ${index}`).join('\n');
    const { segments } = run([`\`\`\`sh\n${body}\n\`\`\`\nafter the block\n`]);
    expect(segments.map(segment => segment.kind)).toEqual(['code', 'code', 'text']);
    expect(segments[0]!.markdown.startsWith('```sh\nline 0')).toBe(true);
    expect(segments[0]!.markdown.endsWith('\n```')).toBe(true);
    expect(segments[1]!.markdown.startsWith('```sh\n')).toBe(true);
    expect(segments[2]).toEqual({ kind: 'text', markdown: 'after the block' });
  });

  it('emits a table whole after its last row and treats a pipe line without a separator as prose', () => {
    const { segments } = run(['| a | b |\n|---|--', '-|\n| 1 | 2 |\n', '| 3 | 4 |\nnext\n', 'x | y\nplain\n']);
    expect(segments).toEqual([
      { kind: 'table', markdown: '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |' },
      { kind: 'text', markdown: 'next' },
      { kind: 'text', markdown: 'x | y\nplain' },
    ]);
  });

  it('flushes an open table at done', () => {
    const { segments } = run(['| k | v |\n|---|---|\n| a | 1 |']);
    expect(segments).toEqual([{ kind: 'table', markdown: '| k | v |\n|---|---|\n| a | 1 |' }]);
  });
});
