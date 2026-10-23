import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFocusTracker, mouseFilteredInput, takeFocusReports, FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON } from '#surfaces/core/terminal-window/index.js';
import { runTerminalWorkline, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import { mountWorkline, WORKLINE_TEST_LABELS, settle, until } from '../support/workline-harness.js';

// T2 (alpha.54): the terminal is asked for focus reports (mode 1004) and rings BEL only while it reported that its window lost focus.
describe('focus reports', () => {
  it('takes ESC [ I / ESC [ O out of the text and keeps the order', () => {
    expect(FOCUS_REPORTING_ON).toBe('\u001b[?1004h'); expect(FOCUS_REPORTING_OFF).toBe('\u001b[?1004l');
    expect(takeFocusReports('a\u001b[Ob\u001b[Ic')).toEqual({ text: 'abc', events: ['out', 'in'] });
    expect(takeFocusReports('\u001b[A\u001b')).toEqual({ text: '\u001b[A\u001b', events: [] });
  });
  it('is unknown until a report arrives', () => {
    const tracker = createFocusTracker(), heard: string[] = [];
    tracker.source.subscribe(event => heard.push(event));
    expect(tracker.source.state()).toBe('unknown');
    tracker.report('out'); expect(tracker.source.state()).toBe('unfocused');
    tracker.report('in'); expect(tracker.source.state()).toBe('focused'); expect(heard).toEqual(['out', 'in']);
  });
  it('the filtered input never hands a focus report to Ink and tracks the state', async () => {
    const real = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return real; } }) as unknown as NodeJS.ReadStream;
    const filtered = mouseFilteredInput(real), seen: string[] = [];
    filtered.input.on('data', chunk => seen.push(String(chunk)));
    (real as unknown as PassThrough).write('x\u001b[Oy');
    await settle(20);
    expect(seen.join('')).toBe('xy'); expect(filtered.focus.state()).toBe('unfocused');
    filtered.close();
  });
});

describe('attention notice', () => {
  const mounted: Array<{ unmount(): void }> = [];
  afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
  it('calls notify once when a turn finishes, not at start-up', async () => {
    const notify = vi.fn();
    const view = mountWorkline({ notify, streamTurn: async function* () {
      await new Promise(resolve => setTimeout(resolve, 150));
      yield { kind: 'message' as const, message: { role: 'assistant' as const, content: 'A', toolCalls: [] } };
      yield { kind: 'text' as const, text: 'A' }; yield { kind: 'done' as const, finish: 'stop' as const };
    } as never });
    mounted.push(view.instance);
    await until(() => view.stdout.frame.includes('READY'), 'ready'); await settle(40);
    expect(notify).not.toHaveBeenCalled();
    for (const char of 'hello\r') { view.stdin.write(char); await settle(3); }
    await until(() => notify.mock.calls.length === 1, 'notified');
    await settle(60);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('the terminal host', () => {
  class Tty extends Writable { text = ''; isTTY = true; rows = 20; columns = 70; override _write(chunk: Buffer, _e: string, done: () => void) { this.text += chunk.toString('utf8'); done(); } }
  async function run(attention: boolean, fullscreen: boolean) {
    const stdout = new Tty(), stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const abort = new AbortController();
    const answer = async function* () { await new Promise(resolve => setTimeout(resolve, 150)); yield { kind: 'message' as const, message: { role: 'assistant' as const, content: 'DONE-ANSWER', toolCalls: [] } };
      yield { kind: 'text' as const, text: 'DONE-ANSWER' }; yield { kind: 'done' as const, finish: 'stop' as const }; };
    const done = runTerminalWorkline({ labels: WORKLINE_TEST_LABELS, palette: resolveWorklinePalette('none'), stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      signal: abort.signal, context: { installationId: 'i', projectId: 'p', scopeId: 's' }, target: 'scope', systemPrompt: 'S', historyMessages: 10, fullscreen,
      ...(attention ? { attention: true } : {}), errorText: error => String(error), completeTurn: async () => 'x', streamTurn: answer as never });
    await until(() => stdout.text.includes('READY'), 'ready');
    return { stdout, stdin, finish: async () => { abort.abort(); await done; } };
  }
  const bells = (text: string) => text.split('\u0007').length - 1;

  it.each([true, false])('asks for focus reports only when attention is on (fullscreen %s), rings only after the window reported it lost focus, and switches reporting off on exit', async fullscreen => {
    const { stdout, stdin, finish } = await run(true, fullscreen);
    expect(stdout.text).toContain('\u001b[?1004h');
    stdin.write('\u001b[O'); await settle(30);   // window lost focus
    stdin.write('hi\r');
    await until(() => stdout.text.includes('DONE-ANSWER'), 'answer');
    await until(() => bells(stdout.text) === 1, 'bell');
    expect(stdout.text).not.toContain('[O');      // the report never reached the composer
    await finish();
    expect(stdout.text).toContain('\u001b[?1004l');
  });

  it('stays silent while focused or when the terminal never reported focus', async () => {
    const focusedRun = await run(true, true);
    focusedRun.stdin.write('\u001b[I'); await settle(30);
    focusedRun.stdin.write('hi\r');
    await until(() => focusedRun.stdout.text.includes('DONE-ANSWER'), 'answer'); await settle(80);
    expect(bells(focusedRun.stdout.text)).toBe(0);
    await focusedRun.finish();
    const unknownRun = await run(true, false);
    unknownRun.stdin.write('hi\r');
    await until(() => unknownRun.stdout.text.includes('DONE-ANSWER'), 'answer'); await settle(80);
    expect(bells(unknownRun.stdout.text)).toBe(0);
    await unknownRun.finish();
  });

  it('with the setting off asks for nothing and never rings', async () => {
    const { stdout, stdin, finish } = await run(false, false);
    expect(stdout.text).not.toContain('?1004');
    stdin.write('hi\r');
    await until(() => stdout.text.includes('DONE-ANSWER'), 'answer'); await settle(80);
    expect(bells(stdout.text)).toBe(0);
    await finish();
  });
});
