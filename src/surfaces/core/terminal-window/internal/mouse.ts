import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createFocusTracker, takeFocusReports, type FocusSource } from './focus.js';

/**
 * Mouse for the full-window conversation (owner 2026-10-18; TERM-POLISH 2026-10-20). The Claude Code fullscreen renderer captures the mouse,
 * scrolls the conversation with the wheel and selects text inside the app: click and drag selects, the selection is copied on mouse release
 * (code.claude.com/docs/en/fullscreen, read 2026-10-20); the terminal's own selection is Shift+drag in most terminals, Option in iTerm2, Fn in
 * Terminal.app. Reporting is on only while the full window is shown: 1000 (press/release), 1002 (motion while a button is held, for the drag)
 * and 1006 (SGR coordinates); never 1003 (all motion). Mouse reports are taken out of the input before Ink parses it: a wheel notch becomes a
 * scroll step, a left-button press / drag / release becomes a pointer event for the selection, every other report is dropped, so no mouse
 * event can ever reach the composer or answer a card.
 */
export const MOUSE_REPORTING_ON = '\u001b[?1000h\u001b[?1002h\u001b[?1006h';
export const MOUSE_REPORTING_OFF = '\u001b[?1006l\u001b[?1002l\u001b[?1000l';
// eslint-disable-next-line no-control-regex -- SGR mouse reports are control sequences.
const SGR_MOUSE = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/gu;
// eslint-disable-next-line no-control-regex -- an SGR mouse report cut at the end of a read.
const SGR_PARTIAL = /\u001b\[<[\d;]*$/u;
const WHEEL_UP = 64, WHEEL_DOWN = 65, MOTION = 32, MODIFIERS = 0b11100, LEFT = 0;

/** A left-button report in 0-based screen cells: `press` starts a selection, `drag` moves its end, `release` ends it. */
export type PointerEvent = Readonly<{ kind: 'press' | 'drag' | 'release'; column: number; row: number }>;

/** Splits one read into the text Ink should see, the wheel steps (−1 up, +1 down) and the left-button pointer events; `carry` is a report
 * cut at the end of the read. */
export function takeMouseReports(chunk: string, carry = ''): Readonly<{ text: string; wheel: readonly number[]; pointer: readonly PointerEvent[]; carry: string }> {
  const input = carry + chunk, wheel: number[] = [], pointer: PointerEvent[] = [];
  let text = input.replace(SGR_MOUSE, (_whole, button: string, x: string, y: string, final: string) => {
    // Bit 2–4 carry Shift/Alt/Ctrl, bit 5 motion; the wheel buttons keep 64/65 in the low bits.
    const code = Number(button), base = code & ~MODIFIERS;
    if (base === WHEEL_UP) wheel.push(-1); else if (base === WHEEL_DOWN) wheel.push(1);
    else if ((base & ~MOTION) === LEFT) {
      const at = { column: Math.max(0, Number(x) - 1), row: Math.max(0, Number(y) - 1) };
      pointer.push({ kind: final === 'm' ? 'release' : base & MOTION ? 'drag' : 'press', ...at });
    }
    return '';
  });
  const partial = SGR_PARTIAL.exec(text);
  const rest = partial ? partial[0] : '';
  if (partial) text = text.slice(0, partial.index);
  return { text, wheel, pointer, carry: rest };
}

/** The terminal clipboard write (OSC 52, BEL-terminated) for text the person selected; nothing else is ever written to the clipboard. */
export function osc52Copy(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
}

export type WheelListener = (step: number) => void;
export type WheelSource = Readonly<{ subscribe: (listener: WheelListener) => () => void }>;
export type PointerListener = (event: PointerEvent) => void;
export type PointerSource = Readonly<{ subscribe: (listener: PointerListener) => () => void }>;

/** The stdin Ink reads: the real TTY's bytes without mouse and focus reports; raw mode and ref/unref go to the real stream. Focus reports only
 * exist while the host switched mode 1004 on (`focus`); the full window also turns on mouse reporting. */
export function mouseFilteredInput(real: NodeJS.ReadStream): Readonly<{ input: NodeJS.ReadStream; wheel: WheelSource; pointer: PointerSource; focus: FocusSource; close: () => void }> {
  const tracker = createFocusTracker();
  const listeners = new Set<WheelListener>(), pointers = new Set<PointerListener>(), out = new PassThrough();
  // Ink sets the encoding on this stream, not on the real TTY, which emits Buffers: one decoder for the whole stream keeps a multi-byte
  // character cut at a read boundary (a large paste) whole instead of two U+FFFD.
  const decoder = new StringDecoder('utf8');
  let carry = '';
  const onData = (chunk: Buffer | string) => {
    const read = takeMouseReports(typeof chunk === 'string' ? chunk : decoder.write(chunk), carry);
    carry = read.carry;
    const focused = takeFocusReports(read.text);
    if (focused.text) out.write(focused.text);
    for (const event of focused.events) tracker.report(event);
    for (const step of read.wheel) for (const listener of listeners) listener(step);
    for (const event of read.pointer) for (const listener of pointers) listener(event);
  };
  real.on('data', onData);
  const input = Object.assign(out, {
    isTTY: true as const,
    setRawMode(mode: boolean) { real.setRawMode(mode); return input; },
    ref() { real.ref(); return input; }, unref() { real.unref(); return input; },
  }) as unknown as NodeJS.ReadStream;
  Object.defineProperty(input, 'isRaw', { get: () => real.isRaw });
  return { input, focus: tracker.source, wheel: { subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    pointer: { subscribe: listener => { pointers.add(listener); return () => { pointers.delete(listener); }; } },
    close: () => { real.off('data', onData); real.pause(); out.end(); } };
}
