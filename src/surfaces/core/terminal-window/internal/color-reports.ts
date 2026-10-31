import LIMITS from './answer-limits.json' with { type: 'json' };

/**
 * The terminal background probe (TEMA-OKUNURLUK §3.2, the Codex `terminal_probe.rs` exchange): OSC 11 asks for the background colour and DA1
 * follows it — every terminal answers DA1, so its answer ends the wait at once where OSC 11 gets none. DEC private mode 2031 (colour palette
 * update notifications) makes a supporting terminal report `CSI ? 997 ; 1|2 n` when its scheme turns dark or light: a new probe follows.
 * Every answer (OSC 10/11, DA1, the 2031 notice) is taken out of the input for the whole session, so none reaches the composer however late it
 * comes; only an answer inside an open probe is used. Ctrl+C typed during a probe ends it and still reaches Ink's normal Ctrl+C path.
 */
export const BACKGROUND_QUERY = '\u001b]11;?\u001b\\\u001b[c';
export const PALETTE_NOTICES_ON = '\u001b[?2031h';
export const PALETTE_NOTICES_OFF = '\u001b[?2031l';
// eslint-disable-next-line no-control-regex -- terminal answers are control sequences.
const ANSWER = /\u001b\]1([01]);([ -~]{0,64}?)(?:\u0007|\u001b\\)|\u001b\[\?[\d;]{0,32}c|\u001b\[\?997;\d{1,3}n/gu;
// The start of an answer at the end of a read, byte by byte in the answer grammar only (`rgb:`/`rgba:` and hex digits, CSI `?` digits), so a key
// that no answer contains (Enter, Ctrl+C, a space) ends it at once. Also a bare `ESC [`, so a mouse or focus report cut there reaches its filter whole.
// eslint-disable-next-line no-control-regex -- terminal answers are control sequences.
const ANSWER_START = /\u001b(?:\](?:1(?:[01](?:;(?:rgba?:[0-9a-f/]*\u001b?|rgba?|rg|r)?)?)?)?|\[(?:\?[\d;]*)?)?$/iu;
// Ctrl+C as a byte or in the kitty keyboard protocol (`CSI 99 ; 5 u`, optionally with an event type).
// eslint-disable-next-line no-control-regex -- Ctrl+C is a control character.
const INTERRUPT = /\u0003|\u001b\[99;5(?::\d)?u/u;

/** An OSC 10/11 colour answer `rgb:R/G/B` (or `rgba:`; 1–4 hex digits per channel, scaled as xterm's XParseColor) as `#RRGGBB`; else null. */
export function parseTerminalColor(answer: string): string | null {
  const match = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/iu.exec(answer);
  if (!match) return null;
  return `#${match.slice(1, 4).map(digits => Math.round(Number.parseInt(digits!, 16) * 255 / (16 ** digits!.length - 1)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export type BackgroundProbe = Readonly<{
  /** Writes the query and resolves with the reported background (`#RRGGBB`), or null when DA1 came first, `limitMs` passed or Ctrl+C was typed. */
  ask: (write: (query: string) => void, limitMs: number) => Promise<string | null>;
  /** Hears each DEC 2031 notice. */
  onPaletteNotice: (listener: () => void) => () => void;
}>;

/**
 * The input stage before the mouse and focus filters: `push` takes every terminal answer out of a read and passes the rest to `deliver` in order.
 * An answer cut at the end of a read is held, bounded by `answerMaxBytes` and by `answerHoldMs` from its first byte; past either bound, or when the
 * next byte leaves the answer grammar, the held bytes go to `deliver` as ordinary input (never dropped, never kept). A lone ESC at the end of a
 * read is held the same way (the escape-time rule of tmux/vim: a 2031 notice comes unasked, so any read may end inside one) and then is the
 * Escape key. One probe at a time; answers that arrive with no probe open are dropped (the theme chosen at start-up stays).
 */
export function createAnswerFilter(deliver: (text: string) => void): Readonly<{ push: (chunk: string) => void; reset: () => void; probe: BackgroundProbe }> {
  const listeners = new Set<() => void>();
  let open: { color: string | null; settle: (color: string | null) => void } | null = null, held = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (color: string | null) => { const current = open; open = null; current?.settle(color); };
  const pass = (text: string) => { if (!text) return; deliver(text); if (INTERRUPT.test(text)) finish(null); };
  const stop = () => { clearTimeout(timer); timer = undefined; };
  const release = () => { stop(); const text = held; held = ''; pass(text); };
  const push = (chunk: string) => {
    let text = (held + chunk).replace(ANSWER, (whole, which: string | undefined, value: string | undefined) => {
      if (which === '1') { if (open) open.color = parseTerminalColor(value ?? ''); }
      else if (whole.endsWith('n')) { for (const listener of listeners) listener(); }
      else if (which === undefined && open) finish(open.color);
      return '';
    });
    const start = ANSWER_START.exec(text);
    held = start && start[0].length <= LIMITS.answerMaxBytes ? start[0] : '';
    if (held) text = text.slice(0, start!.index); else stop();
    if (held && timer === undefined) timer = setTimeout(release, LIMITS.answerHoldMs);
    pass(text);
  };
  return {
    push, reset: () => { stop(); held = ''; },
    probe: {
      ask: (write, limitMs) => {
        if (open) return Promise.resolve(null);
        return new Promise(resolve => {
          const timeout = setTimeout(() => finish(null), limitMs);
          open = { color: null, settle: color => { clearTimeout(timeout); resolve(color); } };
          write(BACKGROUND_QUERY);
        });
      },
      onPaletteNotice: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
  };
}
