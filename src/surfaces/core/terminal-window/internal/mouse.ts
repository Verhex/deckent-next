import { PassThrough } from 'node:stream';

/**
 * Mouse wheel for the full-window conversation (owner 2026-10-18; the Claude Code fullscreen renderer captures the mouse and scrolls the
 * conversation with the wheel; its native selection is Shift+drag in most terminals, Option in iTerm2, Fn in Terminal.app). SGR mouse
 * reporting is on only while the full window is shown. Mouse reports are taken out of the input before Ink parses it: a wheel notch
 * becomes a scroll step for the viewport, every other report (clicks, releases) is dropped, so no mouse event can ever reach the composer
 * or answer a card.
 */
export const MOUSE_REPORTING_ON = '\u001b[?1000h\u001b[?1006h';
export const MOUSE_REPORTING_OFF = '\u001b[?1006l\u001b[?1000l';
// eslint-disable-next-line no-control-regex -- SGR mouse reports are control sequences.
const SGR_MOUSE = /\u001b\[<(\d+);\d+;\d+[Mm]/gu;
// eslint-disable-next-line no-control-regex -- an SGR mouse report cut at the end of a read.
const SGR_PARTIAL = /\u001b\[<[\d;]*$/u;
const WHEEL_UP = 64, WHEEL_DOWN = 65;

/** Splits one read into the text Ink should see and the wheel steps (−1 up, +1 down); `carry` is a report cut at the end of the read. */
export function takeMouseReports(chunk: string, carry = ''): Readonly<{ text: string; wheel: readonly number[]; carry: string }> {
  const input = carry + chunk, wheel: number[] = [];
  let text = input.replace(SGR_MOUSE, (_whole, button: string) => {
    // Bit 2–4 carry Shift/Alt/Ctrl; the wheel buttons keep 64/65 in the low bits.
    const base = Number(button) & ~0b11100;
    if (base === WHEEL_UP) wheel.push(-1); else if (base === WHEEL_DOWN) wheel.push(1);
    return '';
  });
  const partial = SGR_PARTIAL.exec(text);
  const rest = partial ? partial[0] : '';
  if (partial) text = text.slice(0, partial.index);
  return { text, wheel, carry: rest };
}

export type WheelListener = (step: number) => void;
export type WheelSource = Readonly<{ subscribe: (listener: WheelListener) => () => void }>;

/** The stdin Ink reads in the full window: the real TTY's bytes without mouse reports; raw mode and ref/unref go to the real stream. */
export function mouseFilteredInput(real: NodeJS.ReadStream): Readonly<{ input: NodeJS.ReadStream; wheel: WheelSource; close: () => void }> {
  const listeners = new Set<WheelListener>(), out = new PassThrough();
  let carry = '';
  const onData = (chunk: Buffer | string) => {
    const read = takeMouseReports(typeof chunk === 'string' ? chunk : chunk.toString('utf8'), carry);
    carry = read.carry;
    if (read.text) out.write(read.text);
    for (const step of read.wheel) for (const listener of listeners) listener(step);
  };
  real.on('data', onData);
  const input = Object.assign(out, {
    isTTY: true as const,
    setRawMode(mode: boolean) { real.setRawMode(mode); return input; },
    ref() { real.ref(); return input; }, unref() { real.unref(); return input; },
  }) as unknown as NodeJS.ReadStream;
  Object.defineProperty(input, 'isRaw', { get: () => real.isRaw });
  return { input, wheel: { subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    close: () => { real.off('data', onData); real.pause(); out.end(); } };
}
