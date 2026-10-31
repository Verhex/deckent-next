import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_QUERY, createFocusTracker, mouseFilteredInput, takeFocusReports, FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON } from '#surfaces/core/terminal-window/index.js';
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
  it('the filtered input never hands a focus report or a terminal colour answer to Ink, cut at any byte; held bytes are bounded and Ctrl+C always passes', async () => {
    const real = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return real; } }) as unknown as NodeJS.ReadStream;
    const filtered = mouseFilteredInput(real), seen: string[] = [], queries: string[] = [], wheel: number[] = [];
    filtered.input.on('data', chunk => seen.push(String(chunk)));
    filtered.wheel.subscribe(step => wheel.push(step));
    (real as unknown as PassThrough).write('x\u001b[Oy');
    await settle(20);
    expect(seen.join('')).toBe('xy'); expect(filtered.focus.state()).toBe('unfocused');
    const read = (bytes: string) => real.emit('data', Buffer.from(bytes)), ask = (limitMs: number) => filtered.background.ask(query => queries.push(query), limitMs);
    // TEMA-OKUNURLUK §3.2: OSC 11 then DA1; keys typed before and after the answer reach Ink in order; the DA1 answer ends the probe.
    let probe = ask(1_000);
    read('a\u001b]11;rgb:f0f0/ecec/e5e5\u001b\\b'); read('\u001b[?62;22c');
    expect(await probe).toBe('#F0ECE5'); expect(queries).toEqual([BACKGROUND_QUERY]);
    probe = ask(1_000); read('\u001b[?1;2c'); expect(await probe).toBeNull();
    // A late answer (after the limit; slow SSH) is taken out and not used; Ctrl+C ends a probe and still reaches Ink.
    expect(await ask(10)).toBeNull(); read('\u001b]11;rgb:0000/0000/0000\u0007c\u001b]10;rgb:ff/ff/ff\u0007');
    probe = ask(1_000); read('\u0003'); expect(await probe).toBeNull();
    // Answers cut at a read boundary stay out; a cut `ESC [` still reaches the mouse filter whole; DEC 2031 notices are heard.
    let notices = 0; filtered.background.onPaletteNotice(() => { notices++; });
    read('\u001b]11;rgb:ff'); read('/ff/ff\u0007d'); read('\u001b['); read('?62c'); read('\u001b['); read('<65;1;1M'); read('\u001b[?997;2ne');
    await settle(20);
    expect(seen.join('')).toBe('xyabc\u0003de'); expect(wheel).toEqual([1]); expect(notices).toBe(1);
    // Astra 2882 R1: every split of each answer (two reads at each position, then byte by byte) stays out, a lone ESC included, and is used.
    const light = '\u001b]11;rgb:f0/ec/e5\u0007\u001b[?62;22c', lightSt = '\u001b]11;rgb:f0f0/ecec/e5e5\u001b\\\u001b[?62;22c';
    for (const reply of [light, lightSt]) for (let at = 1; at <= reply.length; at++) {
      probe = ask(1_000); const parts = at === reply.length ? [...reply] : [reply.slice(0, at), reply.slice(at)];
      for (const part of parts) read(part);
      expect(await probe, JSON.stringify(parts)).toBe('#F0ECE5');
    }
    for (let at = 1; at < 11; at++) { read('\u001b[?997;1n'.slice(0, at)); read('\u001b[?997;1n'.slice(at)); }
    await settle(20);
    expect(seen.join('')).toBe('xyabc\u0003de'); expect(notices).toBe(11);
    // A lone ESC is the Escape key, held at most `answerHoldMs` (50) with or without a probe; a following key in time joins it (Alt+key, as terminals do).
    seen.length = 0; read('\u001b'); await settle(10); expect(seen.join('')).toBe(''); await settle(60); expect(seen.join('')).toBe('\u001b');
    seen.length = 0; probe = ask(1_000); read('\u001b'); await settle(10); expect(seen.join('')).toBe(''); await settle(60); expect(seen.join('')).toBe('\u001b');
    // Astra 2882 R2: an unterminated answer never keeps keys — a byte outside the answer grammar (Enter, Ctrl+C) releases it as input at once,
    // Ctrl+C (also kitty's CSI 99;5u) still ends the probe, and what stays inside the grammar is released after the window or past `answerMaxBytes`.
    seen.length = 0; read('\u001b]11;rgb:ff'); read('ab\r'); read('\u001b]11;rgb:f'); read('\u0003'); expect(await probe).toBeNull();
    probe = ask(1_000); read('\u001b['); read('99;5u'); expect(await probe).toBeNull();
    read('\u001b]11;rgb:ff/'); await settle(80); read('z'); read(`\u001b]11;rgb:${'f'.repeat(70)}`); await settle(10);
    expect(seen.join('')).toBe(`\u001b]11;rgb:ffab\r\u001b]11;rgb:f\u0003\u001b[99;5u\u001b]11;rgb:ff/z\u001b]11;rgb:${'f'.repeat(70)}`);
    // Astra 2886 R1: a new cut answer after a completed one gets its own window (t0 ESC, t40 answer + new cut answer, t60 its end: nothing leaks).
    seen.length = 0; read('\u001b[?62c'); probe = ask(1_000); read('\u001b'); await settle(40);
    read('\u001b]11;rgb:f0/ec/e5\u0007\u001b]11;rgb:1e/1e/'.slice(1)); await settle(20); read('1e\u0007\u001b[?62c');
    expect(await probe).toBe('#1E1E1E'); await settle(60); expect(seen.join('')).toBe('');
    // Astra 2886 R2: kitty's Ctrl+C (with and without an event type) cut at every byte still ends the probe and reaches Ink whole.
    for (const kitty of ['\u001b[99;5u', '\u001b[99;5:1u']) for (let at = 1; at < kitty.length; at++) {
      seen.length = 0; probe = ask(1_000); read(kitty.slice(0, at)); read(kitty.slice(at));
      expect(await Promise.race([probe, settle(30).then(() => 'still open')]), `${at}`).toBeNull(); await settle(5); expect(seen.join('')).toBe(kitty);
    }
    read('\u001b[?62c'); filtered.close();
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

  it('holds a process warning while the view is mounted and emits it after the view (FIX8a R27: never drawn over the view)', async () => {
    const heard: string[] = [], listener = (warning: Error) => heard.push(warning.message);
    process.on('warning', listener);
    try {
      const { finish } = await run(false, true);
      process.emitWarning('HELD-WARNING'); await settle(30);
      expect(heard).toEqual([]);
      await finish(); await settle(10);
      expect(heard).toEqual(['HELD-WARNING']);
    } finally { process.off('warning', listener); }
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
