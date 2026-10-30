import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { highlightCells, mouseFilteredInput, osc52Copy, selectedText, takeMouseReports, type PointerEvent, type PointerListener, type ViewportBlocks } from '#surfaces/core/terminal-window/index.js';
import type { TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

/**
 * TERM-POLISH (owner 2026-10-20). Mouse: the full window captures the mouse for the wheel, which turns off the terminal's own selection; the
 * Claude Code fullscreen renderer answers that with in-app click-and-drag selection that copies on release (code.claude.com/docs/en/fullscreen,
 * read 2026-10-20). Spacing: a tool step stands apart from the answer text before and after it and from the next tool step.
 */
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });

describe('mouse selection reports', () => {
  it('takes a left-button press, its drag motion and the release out of the input as pointer events; other buttons stay dropped', () => {
    const read = takeMouseReports('a\u001b[<0;3;2Mb\u001b[<32;8;2M\u001b[<32;9;3M\u001b[<0;9;3mc\u001b[<2;1;1M\u001b[<2;1;1m\u001b[<35;4;4M');
    expect(read.text).toBe('abc');
    expect(read.wheel).toEqual([]);
    expect(read.pointer).toEqual([{ kind: 'press', column: 2, row: 1 }, { kind: 'drag', column: 7, row: 1 }, { kind: 'drag', column: 8, row: 2 },
      { kind: 'release', column: 8, row: 2 }]);
  });

  it('OSC 52 carries exactly the selected text, base64 encoded, to the terminal clipboard', () => {
    expect(osc52Copy('şu satır\nnext')).toBe(`\u001b]52;c;${Buffer.from('şu satır\nnext', 'utf8').toString('base64')}\u0007`);
  });
});

describe('selection model', () => {
  const blocks: ViewportBlocks = { keys: ['a', 'b'], linesOf: index => index === 0 ? ['\u001b[2mfirst line\u001b[22m   ', 'ikinci satır'] : ['third'] };
  it('copies the displayed text between two points (colour codes and trailing padding left out), in either drag direction', () => {
    const forward = selectedText(blocks, { key: 'a', line: 0, cell: 6 }, { key: 'b', line: 0, cell: 2 });
    expect(forward).toBe('line\nikinci satır\nthi');
    expect(selectedText(blocks, { key: 'b', line: 0, cell: 2 }, { key: 'a', line: 0, cell: 6 })).toBe(forward);
    expect(selectedText(blocks, { key: 'a', line: 1, cell: 7 }, { key: 'a', line: 1, cell: 11 })).toBe('satır');
  });
  it('highlights the selected cells in reverse video and keeps the reverse across the line\'s own colour codes', () => {
    expect(highlightCells('ab\u001b[2mcd\u001b[22mef', 1, 4)).toBe('a\u001b[7mb\u001b[2m\u001b[7mcd\u001b[22m\u001b[7me\u001b[27mf');
    expect(highlightCells('plain', 0, 4)).toBe('\u001b[7mplain\u001b[27m');
  });
});

type Script = readonly TurnDelta[];
const scripted = (script: Script) => async function* (): AsyncGenerator<TurnDelta> { for (const delta of script) { yield delta; await settle(1); } };
const tool = (callId: string, name: string, target: string): TurnDelta[] => [
  { kind: 'tool', phase: 'started', callId, name, target, status: null, ms: null },
  { kind: 'tool', phase: 'finished', callId, name, target, status: 'ok', ms: 3 }];

/** alpha.59 L6: a read-class call (declared class from the client's tool metadata) with its own result message, so its summary has a kind. */
const read = (callId: string, name: string, target: string, content: string, status: 'ok' | 'error' = 'ok', toolClass: 'read' | 'edit' = 'read'): TurnDelta[] => [
  { kind: 'tool', phase: 'started', callId, name, target, status: null, ms: null, toolClass },
  { kind: 'message', message: { role: 'tool', toolCallId: callId, name, content } },
  { kind: 'tool', phase: 'finished', callId, name, target, status, ms: 3, toolClass }];
const READ_META = '[deckent] read_file: mode=range totalLines=2 range=1-2 returned=2 hasMore=false\n1: a\n2: b';
const reads: Script = [{ kind: 'text', text: 'READS-BEFORE\n' }, ...read('r1', 'read_file', 'x.ts', READ_META), ...read('r2', 'list_dir', 'src', 'a.ts\nlib/'),
  ...read('r3', 'read_file', 'y.ts', READ_META), ...read('r4', 'grep', 'gone', 'boom', 'error'), ...read('w1', 'edit_file', 'z.ts', 'ok', 'ok', 'edit'),
  { kind: 'text', text: 'READS-AFTER\n' }, { kind: 'done', finish: 'stop' }];

describe('spacing between tool steps and answer text', () => {
  const script: Script = [{ kind: 'text', text: 'TEXT-BEFORE\n' }, ...tool('c1', 'read_file', 'a.ts'), ...tool('c2', 'grep', 'needle'),
    { kind: 'text', text: 'TEXT-AFTER\n' }, { kind: 'done', finish: 'stop' }];
  const turns = async function* (messages: readonly { content: unknown }[]): AsyncGenerator<TurnDelta> {
    for (const delta of messages.at(-1)?.content === 'reads' ? reads : script) { yield delta; await settle(1); } };
  for (const fullscreen of [true, false]) {
    it(`one blank line between text and a tool step, between two tool steps, and none inside a block; consecutive reads are one line (${fullscreen ? 'full window' : 'inline'})`, async () => {
      // The full window's mouse: SGR reports through the host's own filter (mouse.ts), as a terminal sends them.
      const real = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return real; } }) as unknown as NodeJS.ReadStream;
      const mouse = mouseFilteredInput(real);
      const view = mountWorkline({ streamTurn: turns, fullscreen, ...(fullscreen ? { pointer: mouse.pointer, copyText: () => {} } : {}),
        labels: { ...WORKLINE_TEST_LABELS, viewport: { below: 'BELOW {count}' } } }, 80, { rows: 40, debug: true });
      mounted.push(view.instance, { unmount: mouse.close });
      view.stdin.write('go'); await settle(20); view.stdin.write('\r');
      await until(() => view.stdout.text.includes('TEXT-AFTER') && view.stdout.frame.includes('READY'), 'turn finished');
      await settle(60);
      const rows = view.stdout.frame.split('\n').map(row => row.trimEnd());
      const at = (token: string) => rows.findIndex(row => row.includes(token));
      const before = at('TEXT-BEFORE'), first = at('TOOL read_file'), second = at('TOOL grep'), after = at('TEXT-AFTER');
      expect([before, first, second, after].every(index => index >= 0), rows.join('\n')).toBe(true);
      expect(first - before, rows.join('\n')).toBe(2); expect(rows[before + 1]).toBe('');
      expect(second - first).toBe(2); expect(rows[first + 1]).toBe('');
      expect(after - second).toBe(2); expect(rows[second + 1]).toBe('');
      // alpha.59 L6 (owner 2026-10-30): consecutive successful reads settle as one summary line; the failed read and the write keep their own lines.
      view.stdin.write('reads'); await settle(20); view.stdin.write('\r');
      await until(() => view.stdout.text.includes('READS-AFTER') && view.stdout.frame.includes('READY'), 'reads finished');
      await settle(60);
      const shown = () => view.stdout.frame.split('\n').map(line => line.trimEnd());
      const summary = () => shown().findIndex(line => line.includes('2 files read, 1 directory listed'));
      expect(summary(), shown().join('\n')).toBeGreaterThan(0);
      expect(shown().some(line => line.includes('TOOL grep gone') && line.includes('TOOL-FAILED'))).toBe(true);
      expect(shown().some(line => line.includes('TOOL edit_file z.ts'))).toBe(true);
      // Inline (no mouse): the calls stay under the summary, never only behind a click. Full window: collapsed until a click shows them.
      expect(shown().some(line => line.includes('TOOL read_file x.ts'))).toBe(!fullscreen);
      expect(shown()[summary()]!.includes('click to show the calls')).toBe(fullscreen);
      if (fullscreen) {
        const click = () => { const row = summary(), column = shown()[row]!.indexOf('files read') + 1;
          real.emit('data', Buffer.from(`\u001b[<0;${column};${row + 1}M\u001b[<0;${column};${row + 1}m`)); };
        click(); await until(() => shown().some(line => line.includes('TOOL read_file x.ts')), 'expanded by a click');
        expect(shown().some(line => line.includes('TOOL list_dir src')) && shown()[summary()]!.includes('click to hide the calls')).toBe(true);
        click(); await until(() => !shown().some(line => line.includes('TOOL read_file x.ts')), 'collapsed by a second click');
      }
    });
  }
});

describe('spacing while the turn streams (no jump when a row lands)', () => {
  for (const fullscreen of [true, false]) {
    it(`the running call and the text after a finished call already stand one blank line apart (${fullscreen ? 'full window' : 'inline'})`, async () => {
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      let resume!: () => void; const gate2 = new Promise<void>(resolve => { resume = resolve; });
      const streamTurn = async function* (): AsyncGenerator<TurnDelta> {
        yield { kind: 'text', text: 'TEXT-BEFORE\n' };
        yield { kind: 'tool', phase: 'started', callId: 'c1', name: 'read_file', target: 'a.ts', status: null, ms: null };
        await gate;
        yield { kind: 'tool', phase: 'finished', callId: 'c1', name: 'read_file', target: 'a.ts', status: 'ok', ms: 3 };
        yield { kind: 'text', text: 'PARTIAL-AFTER' };
        await gate2;
        yield { kind: 'text', text: ' DONE\n' }; yield { kind: 'done', finish: 'stop' };
      };
      const view = mountWorkline({ streamTurn, fullscreen, labels: { ...WORKLINE_TEST_LABELS, viewport: { below: 'BELOW {count}' } } }, 80, { rows: 30, debug: true });
      mounted.push(view.instance);
      view.stdin.write('go'); await settle(20); view.stdin.write('\r');
      const rows = () => view.stdout.frame.split('\n').map(row => row.trimEnd());
      const gap = (above: string, below: string) => { const all = rows(), top = all.findIndex(row => row.includes(above)), low = all.findIndex(row => row.includes(below));
        return top >= 0 && low >= 0 ? low - top : -1; };
      await until(() => gap('TEXT-BEFORE', 'RUNNING') > 0, 'running call');
      expect(gap('TEXT-BEFORE', 'RUNNING'), rows().join('\n')).toBe(2);
      release();
      await until(() => gap('TOOL read_file', 'PARTIAL-AFTER') > 0, 'partial text');
      expect(gap('TOOL read_file', 'PARTIAL-AFTER'), rows().join('\n')).toBe(2);
      expect(gap('TEXT-BEFORE', 'TOOL read_file')).toBe(2);
      resume();
      await until(() => view.stdout.frame.includes('PARTIAL-AFTER DONE') && view.stdout.frame.includes('READY'), 'finished');
      expect(gap('TOOL read_file', 'PARTIAL-AFTER DONE'), rows().join('\n')).toBe(2);
    });
  }
});

describe('click-and-drag selection in the full window', () => {
  const fakePointer = () => {
    const listeners = new Set<PointerListener>();
    return { source: { subscribe: (listener: PointerListener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
      send: (event: PointerEvent) => { for (const listener of listeners) listener(event); } };
  };
  const answer: Script = [{ kind: 'text', text: 'alpha line one\n\nbeta line two\n' }, { kind: 'done', finish: 'stop' }];

  it('drag over the answer highlights it, the release copies exactly the shown text once, the hint row says so and the bar stays put', async () => {
    const pointer = fakePointer(), copies: string[] = [];
    const view = mountWorkline({ streamTurn: scripted(answer), fullscreen: true, pointer: pointer.source, copyText: text => { copies.push(text); },
      labels: { ...WORKLINE_TEST_LABELS, viewport: { below: 'BELOW {count}', copied: 'COPIED {count}' } } }, 80, { rows: 24, debug: true });
    mounted.push(view.instance);
    view.stdin.write('go'); await settle(20); view.stdin.write('\r');
    await until(() => view.stdout.frame.includes('beta line two') && view.stdout.frame.includes('READY'), 'answer');
    await settle(60);
    const before = view.stdout.frame.split('\n'), bar = before.findLastIndex(row => row.startsWith('╭'));
    const first = before.findIndex(row => row.includes('alpha line one')), second = before.findIndex(row => row.includes('beta line two'));
    const column = (row: number, token: string) => before[row]!.indexOf(token);
    // A press in the live/bar area starts nothing; a press on the answer starts the selection.
    pointer.send({ kind: 'press', column: 3, row: bar + 1 }); pointer.send({ kind: 'release', column: 3, row: bar + 1 }); await settle(30);
    expect(copies).toEqual([]);
    pointer.send({ kind: 'press', column: column(first, 'line one'), row: first });
    pointer.send({ kind: 'drag', column: column(second, 'beta') + 3, row: second }); await settle(30);
    expect(view.stdout.frame).toContain('\u001b[7m');
    pointer.send({ kind: 'release', column: column(second, 'beta') + 3, row: second }); await settle(60);
    // Exactly what the screen shows from the press to the release cell, as a terminal's own selection copies it (the answer's indent included).
    expect(copies).toEqual(['line one\n\n  beta']);
    const after = view.stdout.frame.split('\n');
    expect(after.findLastIndex(row => row.startsWith('╭'))).toBe(bar);
    expect(after.some(row => row.includes('COPIED 16'))).toBe(true);
    // A key clears the highlight (and still reaches the composer); a plain click copies nothing.
    view.stdin.write('x'); await settle(40);
    expect(view.stdout.frame).not.toContain('\u001b[7m'); expect(view.stdout.frame).toContain('> x');
    pointer.send({ kind: 'press', column: 4, row: first }); pointer.send({ kind: 'release', column: 4, row: first }); await settle(30);
    expect(copies).toHaveLength(1);
  });

  it('while an answer streams under a full view (the column clipped at the top), a press on the top row selects the line shown there', async () => {
    const pointer = fakePointer(), copies: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const streamTurn = async function* (messages: readonly { content: unknown }[]): AsyncGenerator<TurnDelta> {
      if (messages.at(-1)?.content === 'fill') { yield { kind: 'text', text: Array.from({ length: 40 }, (_, i) => `fill-line-${i}`).join('\n\n') + '\n' }; yield { kind: 'done', finish: 'stop' }; return; }
      yield { kind: 'text', text: 'streaming one\nstreaming two\nstreaming three' }; await gate; yield { kind: 'done', finish: 'stop' };
    };
    const view = mountWorkline({ streamTurn, fullscreen: true, pointer: pointer.source, copyText: text => { copies.push(text); },
      labels: { ...WORKLINE_TEST_LABELS, viewport: { below: 'BELOW {count}', copied: 'COPIED {count}' } } }, 80, { rows: 24, debug: true });
    mounted.push(view.instance);
    view.stdin.write('fill'); await settle(20); view.stdin.write('\r');
    await until(() => view.stdout.frame.includes('fill-line-39') && view.stdout.frame.includes('READY'), 'filled');
    view.stdin.write('more'); await settle(20); view.stdin.write('\r');
    await until(() => view.stdout.frame.includes('streaming three'), 'streaming');
    await settle(60);
    const top = view.stdout.frame.split('\n').find(row => row.trim() !== '')!, index = view.stdout.frame.split('\n').indexOf(top);
    pointer.send({ kind: 'press', column: 0, row: index }); pointer.send({ kind: 'drag', column: 11, row: index }); pointer.send({ kind: 'release', column: 11, row: index });
    await settle(40);
    expect(copies, view.stdout.frame).toEqual([top.slice(0, 12).trimEnd()]);
    release();
  });
});
