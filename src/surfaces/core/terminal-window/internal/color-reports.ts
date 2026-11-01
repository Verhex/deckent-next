import LIMITS from './answer-limits.json' with { type: 'json' };

/**
 * The terminal background probe (TEMA-OKUNURLUK §3.2, the Codex `terminal_probe.rs` exchange): OSC 11 asks for the background colour and DA1
 * follows it — every terminal answers DA1, so its answer ends the wait at once where OSC 11 gets none. DEC private mode 2031 (colour palette
 * update notifications) makes a supporting terminal report `CSI ? 997 ; 1|2 n` when its scheme turns dark or light: a new probe follows.
 * Every answer (OSC 10/11, DA1, the 2031 notice) is taken out of the input for the whole session, so none reaches the composer however late it
 * comes; kitty keyboard replies go only to Ink's negotiation listener. Only a colour answer inside an open probe is used.
 * Ctrl+C typed during a probe ends it and still reaches Ink's normal Ctrl+C path.
 */
export const BACKGROUND_QUERY = '\u001b]11;?\u001b\\\u001b[c';
export const PALETTE_NOTICES_ON = '\u001b[?2031h';
export const PALETTE_NOTICES_OFF = '\u001b[?2031l';
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
 * Frames terminal input before Ink. OSC/DCS strings and CSI replies never become keys, even when split or oversized. Only a lone ESC
 * expires into the Escape key; a recognised control frame keeps draining without retaining its payload after the time/size bound.
 * Enter/Ctrl+C break a malformed frame and still pass. Ordinary keys, mouse/focus reports and keyboard CSI sequences keep their order.
 */
export function createAnswerFilter(deliver: (text: string) => void, kittyReply: (reply: string) => void = () => {}): Readonly<{ push: (chunk: string) => void; reset: () => void; probe: BackgroundProbe }> {
  const listeners = new Set<() => void>();
  let open: { color: string | null; settle: (color: string | null) => void } | null = null;
  let mode: 'text' | 'escape' | 'csi' | 'osc' | 'dcs' = 'text', held = '', expired = false, stringEscape = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (color: string | null) => { const current = open; open = null; current?.settle(color); };
  const pass = (text: string) => { if (!text) return; deliver(text); if (INTERRUPT.test(text)) finish(null); };
  const stop = () => { clearTimeout(timer); timer = undefined; };
  const reset = () => { stop(); mode = 'text'; held = ''; expired = false; stringEscape = false; };
  const begin = () => {
    mode = 'escape'; held = '\u001b';
    timer = setTimeout(() => {
      timer = undefined;
      if (mode === 'escape') { reset(); pass('\u001b'); }
      else { held = ''; expired = true; } // A terminal response cannot turn into a key at its bound.
    }, LIMITS.answerHoldMs);
  };
  const answer = () => {
    const sequence = held, kind = mode, dropped = expired;
    reset();
    if (dropped) return '';
    if (kind === 'osc') {
      // eslint-disable-next-line no-control-regex -- terminal replies are control sequences.
      const match = /^\u001b\]11;(.*?)(?:\u0007|\u001b\\)$/u.exec(sequence);
      if (match && open) open.color = parseTerminalColor(match[1]!);
    } else if (kind === 'csi') {
      // eslint-disable-next-line no-control-regex -- terminal replies are control sequences.
      if (/^\u001b\[\?\d+u$/u.test(sequence)) kittyReply(sequence);
      // eslint-disable-next-line no-control-regex -- terminal replies are control sequences.
      else if (/^\u001b\[\?997;\d+n$/u.test(sequence)) { for (const listener of listeners) listener(); }
      // eslint-disable-next-line no-control-regex -- terminal replies are control sequences.
      else if (/^\u001b\[\?[\d;]*c$/u.test(sequence)) finish(open?.color ?? null);
      // CSI replies (DA, DSR, CPR, window/device reports) are not keyboard events. Mouse, focus, arrows, paste and kitty keys pass on.
      // eslint-disable-next-line no-control-regex -- terminal replies are control sequences.
      else if (!/^\u001b\[[?>=]/u.test(sequence) && !/[cnRty]$/u.test(sequence)) return sequence;
    }
    return '';
  };
  const push = (chunk: string) => {
    let text = '';
    const flush = () => { pass(text); text = ''; };
    for (const char of chunk) {
      if (mode === 'text') { if (char === '\u001b') begin(); else text += char; continue; }
      if (mode === 'escape') {
        if (char === '[' || char === ']' || char === 'P') { mode = char === '[' ? 'csi' : char === ']' ? 'osc' : 'dcs'; held += char; continue; }
        const prefix = held; reset(); text += prefix + char; continue; // Alt+key (including Alt+Enter), not a terminal reply.
      }
      // C0 keys abort an incomplete reply. Never hand its control prefix to a decision card.
      if (char < ' ' && char !== '\u001b' && !(mode === 'osc' && char === '\u0007')) { reset(); text += char; continue; }
      if (!expired) {
        held += char;
        if (held.length > LIMITS.answerMaxBytes) { held = ''; expired = true; }
      }
      if (mode === 'csi') {
        if (char >= '@' && char <= '~') { text += answer(); }
        else if (char === '\u001b') { reset(); begin(); }
      } else {
        if ((mode === 'osc' && char === '\u0007') || (stringEscape && char === '\\')) { text += answer(); }
        else stringEscape = char === '\u001b';
      }
    }
    flush();
  };
  return {
    push, reset,
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
