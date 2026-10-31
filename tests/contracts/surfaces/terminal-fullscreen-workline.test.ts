import { afterEach, describe, expect, it } from 'vitest';
import { Writable, PassThrough } from 'node:stream';
import { cells } from '#surfaces/core/terminal-render/index.js';
import { fullscreenFrameRows, fullscreenInfoRows, mouseFilteredInput, promptJump, scrollViewport, searchViewport, takeMouseReports, viewportLines, viewportStart, type ViewportBlocks } from '#surfaces/core/terminal-window/index.js';
import { runTerminalWorkline, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import type { TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

/** TERMINAL-SABIT-DUZEN (owner 2026-10-18): the full-window layout keeps the input bar on one row whatever the conversation does. */
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
const PGUP = '\u001b[5~', PGDN = '\u001b[6~', CTRL_END = '\u001b[1;5F', CTRL_HOME = '\u001b[1;5H';
const focus = { composer: 'INPUT-FOCUS', window: 'WINDOW-FOCUS', decide: 'DECIDE-HERE' };
const labels = { ...WORKLINE_TEST_LABELS, focus, viewport: { below: 'BELOW {count}' } };

function mount(props: Parameters<typeof mountWorkline>[0], columns = 80, rows = 24) {
  const view = mountWorkline({ ...props, labels: { ...labels, ...props.labels }, fullscreen: true }, columns, { rows, debug: true });
  mounted.push(view.instance); return view;
}
const frameOf = (view: ReturnType<typeof mountWorkline>) => view.stdout.frame.replace(/\n$/u, '').split('\n');
/** The bar: the composer's bottom border sits right above the information rows; the status row is the first information row. */
function barRow(frame: readonly string[], rows: number): number {
  const info = fullscreenInfoRows(fullscreenFrameRows(rows, 'linux')), bottom = rows - info - 1;
  expect(frame).toHaveLength(rows);
  expect(frame[bottom]).toMatch(/^╰/u);
  expect(frame[bottom + 1]).toMatch(/READY|BUSY/u);
  // The composer's top border is the last frame top above the bottom border.
  let top = bottom - 1; while (top > 0 && !frame[top]!.startsWith('╭')) top--;
  return top;
}

const hold = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const approvalTurn = (gate: Promise<void>, previewLines: number) => async function* (messages: readonly { content: unknown }[]): AsyncGenerator<TurnDelta> {
  if (messages.at(-1)?.content !== 'go') { yield { kind: 'text', text: `warm answer ${String(messages.at(-1)?.content)}\n` }; yield { kind: 'done', finish: 'stop' }; return; }
  yield { kind: 'text', text: 'CHAT-BEFORE-CARD\n' };
  yield { kind: 'tool', phase: 'started', callId: 'c1', name: 'run_shell', target: 'rm -rf build', status: null, ms: null };
  yield { kind: 'approval', phase: 'requested', callId: 'c1', approvalId: 'appr-long', revision: 0, summary: 'run_shell · rm -rf build · 0123456789ab',
    preview: Array.from({ length: previewLines }, (_, i) => `preview-line-${i}`).join('\n'), expiresAt: Date.now() + 600_000, risk: 'shell-destructive',
    tool: 'run_shell', target: 'rm -rf build' };
  await gate;
  yield { kind: 'done', finish: 'stop' };
};
const ledger = (calls: unknown[][]) => ({ scopeId: 'scope-a', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope-a', sources: [] } as never; }, async inspectRun() { return null; },
  async decideApproval(approval: { approvalId: string }, decision: string, standing?: string, reason?: string) {
    calls.push([approval.approvalId, decision, standing, reason]);
    return { approvalId: approval.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided' as const, decision, expiresAt: 0 };
  } });

describe('full-window Workline: fixed bar', () => {
  it('keeps the bar row through an empty screen, a long conversation, a streamed answer and typing while it streams', async () => {
    let turnNo = 0;
    const view = mount({ streamTurn: async function* (): AsyncGenerator<TurnDelta> {
      turnNo += 1;
      const count = turnNo === 25 ? 60 : 2;
      for (let i = 0; i < count; i++) { yield { kind: 'text', text: `answer-${turnNo}-line-${i}\n` }; if (turnNo === 25) await settle(5); }
      yield { kind: 'done', finish: 'stop' };
    } });
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    const empty = barRow(frameOf(view), 24);
    for (let i = 1; i <= 24; i++) { view.stdin.write(`message ${i}\r`); await until(() => view.stdout.frame.includes(`answer-${i}-line-1`), `answer ${i}`); }
    expect(barRow(frameOf(view), 24)).toBe(empty);
    view.stdin.write('long one\r'); await until(() => view.stdout.frame.includes('answer-25-line-10'), 'streaming');
    view.stdin.write('typed while streaming');
    const rowsWhileStreaming: number[] = [];
    for (let i = 0; i < 6; i++) { await settle(25); rowsWhileStreaming.push(barRow(frameOf(view), 24)); }
    await until(() => view.stdout.frame.includes('answer-25-line-59') && view.stdout.frame.includes('READY'), 'stream end');
    expect(new Set([...rowsWhileStreaming, barRow(frameOf(view), 24)])).toEqual(new Set([empty]));
    expect(view.stdout.frame).toContain('typed while streaming');
    // Newest line sits right above the bar (bottom-anchored conversation), with tema L6's one fixed blank row between them.
    const frame = frameOf(view);
    expect(frame[empty - 1]).toBe(''); expect(frame.slice(empty - 3, empty - 1).some(row => row.includes('answer-25-line-59'))).toBe(true);
  });

  it('a long approval card opens above the bar and closes again with the bar on the same row (owner finding 2026-10-18)', async () => {
    const gate = hold(), calls: unknown[][] = [];
    const view = mount({ labels: { ...labels, work: workSurfaceLabels('en') }, ledger: ledger(calls) as never, streamTurn: approvalTurn(gate.promise, 60) as never });
    try {
      await until(() => view.stdout.frame.includes('READY'), 'ready');
      for (let i = 0; i < 3; i++) { view.stdin.write(`warm ${i}\r`); await settle(30); }
      await settle(60);
      const before = barRow(frameOf(view), 24);
      view.stdin.write('go\r');
      await until(() => view.stdout.frame.includes('Approval needed') && view.stdout.frame.includes('CHAT-BEFORE-CARD'), 'card'); await settle(40);
      const open = frameOf(view);
      // Slice 2 (Claude Code style): the focused card takes the bar's place — its bottom border sits on the bar's bottom row, the composer is
      // hidden (kept mounted), and the card grows upward, capped at half the frame (internal scroll).
      const bottom = 24 - fullscreenInfoRows(fullscreenFrameRows(24, 'linux')) - 1;
      expect(open[bottom]).toMatch(/^╰/u); expect(open[bottom + 1]).toMatch(/READY|BUSY/u); expect(open.some(row => row.startsWith('│ > '))).toBe(false);
      const cardTop = open.findIndex(row => row.includes('Approval needed')) - 1;
      expect(cardTop).toBeGreaterThan(0); expect(bottom - cardTop + 1).toBeLessThanOrEqual(12);
      // The conversation stays anchored to its bottom: its newest rows sit right above the card.
      expect(open.slice(0, cardTop).some(row => row.includes('CHAT-BEFORE-CARD'))).toBe(true);
      view.stdin.write('n');
      await until(() => calls.length === 1 && !view.stdout.frame.includes('Approval needed'), 'card answered and closed');
      await settle(60);
      expect(barRow(frameOf(view), 24)).toBe(before);
      expect(calls[0]![1]).toBe('deny');
    } finally { gate.release(); }
  });

  it('scrolls back with PgUp, stays put while lines arrive, says how many lines are below, and follows again with Ctrl+End', async () => {
    let n = 0;
    const view = mount({ completeTurn: async () => { n += 1; return Array.from({ length: 30 }, (_, i) => `r${n}-row-${i}`).join('\n'); } });
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    view.stdin.write('first\r'); await until(() => view.stdout.frame.includes('r1-row-29'), 'first answer');
    const bar = barRow(frameOf(view), 24);
    view.stdin.write(PGUP); await until(() => view.stdout.frame.includes('BELOW'), 'scrolled back');
    const scrolled = frameOf(view).slice(0, bar).filter(Boolean);
    expect(scrolled.some(row => row.includes('r1-row-29'))).toBe(false);
    view.stdin.write('second\r'); await until(() => /BELOW \d+/u.test(view.stdout.frame) && n === 2, 'second answer while scrolled'); await settle(80);
    expect(frameOf(view).slice(0, bar).filter(row => row && !row.startsWith('BELOW'))).toEqual(scrolled.filter(row => !row.startsWith('BELOW')));
    expect(barRow(frameOf(view), 24)).toBe(bar);
    view.stdin.write(CTRL_HOME); await settle(60); expect(view.stdout.frame).toMatch(/you|first/u);
    view.stdin.write(CTRL_END); await until(() => view.stdout.frame.includes('r2-row-29') && !view.stdout.frame.includes('BELOW'), 'follow again');
    view.stdin.write(PGUP); await settle(40); view.stdin.write(PGDN); view.stdin.write(PGDN); view.stdin.write(PGDN);
    await until(() => !view.stdout.frame.includes('BELOW'), 'paging down to the end follows');
  });

  it('resize keeps the bar at the new bottom; 40 columns, long lines and wide characters fit; NO_COLOR has no colour codes', async () => {
    const wide = `${'漢字Türkçe'.repeat(30)} ${'x'.repeat(300)}`;
    const view = mount({ completeTurn: async () => wide }, 40, 20);
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    view.stdin.write('w\r'); await until(() => view.stdout.frame.includes('xxx'), 'wide answer'); await settle(60);
    barRow(frameOf(view), 20);
    for (const [rows, columns] of [[30, 100], [12, 40], [24, 60]] as const) {
      Object.assign(view.stdout, { rows, columns }); view.stdout.emit('resize'); await settle(120);
      const frame = frameOf(view);
      barRow(frame, rows);
      expect(frame.every(row => cells(row) <= columns)).toBe(true);
    }
    expect(view.stdout.text.split('\u001b[').slice(1).some(sequence => /^[\d;]*m/u.test(sequence))).toBe(false);
  });
});

describe('full-window Workline on a terminal', () => {
  class Tty extends Writable { text = ''; isTTY = true; rows = 20; columns = 70; override _write(chunk: Buffer, _e: string, done: () => void) { this.text += chunk.toString('utf8'); done(); } }
  it('enters the alternate screen, leaves it on exit and writes the conversation to the main screen scrollback', async () => {
    const stdout = new Tty(), stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const abort = new AbortController();
    const run = runTerminalWorkline({ labels, palette: resolveWorklinePalette('none'), stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      signal: abort.signal, context: { installationId: 'i', projectId: 'p', scopeId: 's' }, target: 'scope', systemPrompt: 'S', historyMessages: 10,
      errorText: error => String(error), completeTurn: async () => 'MAIN-SCREEN-ANSWER' });
    await until(() => stdout.text.includes('READY'), 'ready');
    expect(stdout.text).toContain('\u001b[?1049h');
    stdin.write('KEEP-ME\r'); await until(() => stdout.text.includes('MAIN-SCREEN-ANSWER'), 'answer');
    expect(terminalBuffers(stdout.text, 70, 20).alternate).toBe(true);
    abort.abort(); await run;
    const after = terminalBuffers(stdout.text, 70, 20);
    expect(after.alternate).toBe(false);
    expect(after.main).toContain('KEEP-ME'); expect(after.main).toContain('MAIN-SCREEN-ANSWER');
    expect(after.main).not.toContain('READY');
  });

  it('the inline layout stays available (`fullscreen: false`): no alternate screen', async () => {
    const stdout = new Tty(), stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const abort = new AbortController();
    const run = runTerminalWorkline({ labels, palette: resolveWorklinePalette('none'), stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      signal: abort.signal, context: { installationId: 'i', projectId: 'p', scopeId: 's' }, target: 'scope', systemPrompt: 'S', historyMessages: 10, fullscreen: false,
      errorText: error => String(error), completeTurn: async () => 'x' });
    await until(() => stdout.text.includes('READY'), 'ready'); abort.abort(); await run;
    expect(stdout.text).not.toContain('\u001b[?1049h');
  });
});

describe('viewport scroll model', () => {
  const blocks = (sizes: readonly number[]): ViewportBlocks => ({ keys: sizes.map((_, i) => `b${i}`),
    linesOf: index => Array.from({ length: sizes[index] ?? 0 }, (_, line) => `b${index}:${line}`) });
  // Each drawn line's content position (TERM-POLISH selection anchor): the block key and the line in it.
  const atOf = (lines: readonly string[]) => lines.map(text => ({ key: text.split(':')[0], line: Number(text.split(':')[1]) }));
  it('follows the end, anchors on scroll back, stays anchored as lines are appended, and returns to follow at the end', () => {
    const three = blocks([5, 5, 5]);
    expect(viewportLines(three, null, 4)).toEqual({ lines: ['b2:1', 'b2:2', 'b2:3', 'b2:4'], at: atOf(['b2:1', 'b2:2', 'b2:3', 'b2:4']), below: null });
    const anchor = scrollViewport(three, null, 4, -6);
    expect(anchor).toEqual({ key: 'b1', line: 0 });
    expect(viewportLines(three, anchor, 4)).toEqual({ lines: ['b1:0', 'b1:1', 'b1:2'], at: atOf(['b1:0', 'b1:1', 'b1:2']), below: 7 });
    // Appending a block below does not move the anchored view.
    expect(viewportLines(blocks([5, 5, 5, 9]), anchor, 4).lines).toEqual(['b1:0', 'b1:1', 'b1:2']);
    expect(scrollViewport(three, anchor, 4, 100)).toBeNull();
    expect(viewportStart(three, 4)).toEqual({ key: 'b0', line: 0 });
    expect(viewportStart(blocks([2]), 4)).toBeNull();
    // A block that left the bounded history: the oldest line still there.
    expect(viewportLines(blocks([5, 5]), { key: 'gone', line: 3 }, 4).lines[0]).toBe('b0:0');
    expect(viewportLines(blocks([]), null, 4)).toEqual({ lines: [], at: [], below: null });
  });
  it('searches older/newer lines from the view (colour codes ignored) and jumps between prompt blocks', () => {
    const base = blocks([3, 3, 3, 3]), coloured = { ...base, linesOf: (index: number) => base.linesOf(index).map(line => line === 'b1:1' ? '\u001b[1mB1:1\u001b[22m' : line),
      isPrompt: (index: number) => index % 2 === 0 };
    expect(searchViewport(coloured, null, 3, 'b1:1', -1)).toEqual({ key: 'b1', line: 1 });
    expect(searchViewport(coloured, { key: 'b0', line: 0 }, 3, 'b2:2', 1)).toEqual({ key: 'b2', line: 2 });
    expect(searchViewport(coloured, null, 3, 'absent', -1)).toBe('none');
    expect(promptJump(coloured, null, 3, -1)).toEqual({ key: 'b2', line: 0 });
    expect(promptJump(coloured, { key: 'b2', line: 0 }, 3, -1)).toEqual({ key: 'b0', line: 0 });
    expect(promptJump(coloured, { key: 'b0', line: 0 }, 3, 1)).toEqual({ key: 'b2', line: 0 });
    expect(promptJump(coloured, { key: 'b2', line: 0 }, 3, 1)).toBeNull();
  });
});

describe('mouse reports', () => {
  it('takes wheel notches (with modifiers) and left clicks out of the input, keeps keys and carries a report cut at the end of a read', () => {
    const read = takeMouseReports('a\u001b[<64;3;4Mb\u001b[<65;3;4M\u001b[<0;1;1M\u001b[<0;1;1mc\u001b[<68;1;1M\u001b');
    // A left click is a pointer event for the selection (TERM-POLISH), never input text.
    expect(read).toEqual({ text: 'abc\u001b', wheel: [-1, 1, -1], pointer: [{ kind: 'press', column: 0, row: 0 }, { kind: 'release', column: 0, row: 0 }], carry: '' });
    const cut = takeMouseReports('x\u001b[<65;1');
    expect(cut).toEqual({ text: 'x', wheel: [], pointer: [], carry: '\u001b[<65;1' });
    expect(takeMouseReports(';1M\r', cut.carry)).toEqual({ text: '\r', wheel: [1], pointer: [], carry: '' });
  });
  it('keeps a multi-byte character cut at a read boundary whole (a large paste of Turkish text; the TTY emits Buffers)', async () => {
    const real = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return real; } }) as unknown as NodeJS.ReadStream;
    const mouse = mouseFilteredInput(real), wheel: number[] = [];
    mouse.wheel.subscribe(step => wheel.push(step));
    // Ink sets the encoding on the stream it reads, as here; 'ş' is C5 9F, split across two reads, with a wheel notch in the second read.
    mouse.input.setEncoding('utf8'); let text = ''; mouse.input.on('data', (chunk: string) => { text += chunk; });
    real.emit('data', Buffer.from([0x61, 0x6b, 0x61, 0xc5]));
    real.emit('data', Buffer.concat([Buffer.from([0x9f]), Buffer.from('\u001b[<65;1;1Mi ğüİ', 'utf8')]));
    await settle(10);
    expect(text).toBe('akaşi ğüİ'); expect(text).not.toContain('\ufffd'); expect(wheel).toEqual([1]);
    mouse.close();
  });
  it('N1: bytes another view reads while the terminal is handed over never reach the composer stream', async () => {
    const real = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return real; } }) as unknown as NodeJS.ReadStream;
    const mouse = mouseFilteredInput(real);
    mouse.input.setEncoding('utf8'); real.emit('data', Buffer.from('queued'));
    // The /setup window reads the same TTY while it owns it; Node emits 'data' for its reads too.
    mouse.hold(true); real.emit('data', Buffer.from('abc\r')); mouse.hold(false);
    let text = ''; mouse.input.on('data', (chunk: string) => { text += chunk; });
    real.emit('data', Buffer.from('x'));
    await settle(10);
    expect(text).toBe('x');
    mouse.close();
  });
});
