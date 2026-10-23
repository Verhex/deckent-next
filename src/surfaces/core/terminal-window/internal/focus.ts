/**
 * Terminal focus reports (xterm mode 1004, the reference Claude Code and Codex use to notify only while the window is in the background).
 * With the mode on a supporting terminal writes `ESC [ I` when the window gains focus and `ESC [ O` when it loses it. The reports are taken
 * out of the input before Ink parses it, so they can never reach the composer. A terminal that does not know the mode (or a multiplexer
 * that does not forward it, e.g. tmux without `focus-events on`) sends nothing: the state then stays `unknown` and nothing is rung.
 */
export const FOCUS_REPORTING_ON = '\u001b[?1004h';
export const FOCUS_REPORTING_OFF = '\u001b[?1004l';
// eslint-disable-next-line no-control-regex -- focus reports are control sequences.
const FOCUS_REPORT = /\u001b\[([IO])/gu;

export type FocusEvent = 'in' | 'out';
export type FocusState = 'focused' | 'unfocused' | 'unknown';
export type FocusListener = (event: FocusEvent) => void;
export type FocusSource = Readonly<{ subscribe: (listener: FocusListener) => () => void; state: () => FocusState }>;

/** Splits one read into the text Ink should see and the focus events it carried, in order. */
export function takeFocusReports(chunk: string): Readonly<{ text: string; events: readonly FocusEvent[] }> {
  const events: FocusEvent[] = [];
  const text = chunk.replace(FOCUS_REPORT, (_whole, final: string) => { events.push(final === 'I' ? 'in' : 'out'); return ''; });
  return { text, events };
}

/** The last reported focus; listeners hear every event. */
export function createFocusTracker(): Readonly<{ source: FocusSource; report: (event: FocusEvent) => void }> {
  const listeners = new Set<FocusListener>();
  let state: FocusState = 'unknown';
  return {
    source: { subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, state: () => state },
    report: event => { state = event === 'in' ? 'focused' : 'unfocused'; for (const listener of listeners) listener(event); },
  };
}
