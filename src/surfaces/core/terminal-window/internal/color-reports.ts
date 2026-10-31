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
const ANSWER = /\u001b\]1([01]);([^\u0007\u001b]*)(?:\u0007|\u001b\\)|\u001b\[\?[\d;]*c|\u001b\[\?997;\d+n/gu;
// An answer cut at the end of a read (a lone ESC stays: it is the Escape key); runs before the mouse and focus filters, so a carried `ESC [` reaches them whole.
// eslint-disable-next-line no-control-regex -- terminal answers are control sequences.
const ANSWER_PARTIAL = /\u001b(?:\](?:1(?:[01](?:;[^\u0007\u001b]*\u001b?)?)?)?|\[(?:\?[\d;]*)?)$/u;

/** An OSC 10/11 colour answer `rgb:R/G/B` (or `rgba:`; 1–4 hex digits per channel, scaled as xterm's XParseColor) as `#RRGGBB`; else null. */
export function parseTerminalColor(answer: string): string | null {
  const match = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/iu.exec(answer);
  if (!match) return null;
  return `#${match.slice(1, 4).map(digits => Math.round(Number.parseInt(digits!, 16) * 255 / (16 ** digits!.length - 1)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export type ColorReport = Readonly<{ kind: 'background'; color: string | null } | { kind: 'end' } | { kind: 'palette' }>;

/** Splits one read into the text Ink should see and the terminal answers it carried, in order; `carry` is an answer cut at the end of the read. */
export function takeColorReports(chunk: string, carry = ''): Readonly<{ text: string; reports: readonly ColorReport[]; carry: string }> {
  const reports: ColorReport[] = [];
  let text = (carry + chunk).replace(ANSWER, (whole, which: string | undefined, value: string | undefined) => {
    if (which === '1') reports.push({ kind: 'background', color: parseTerminalColor(value ?? '') });
    else if (which === undefined) reports.push(whole.endsWith('n') ? { kind: 'palette' } : { kind: 'end' });
    return '';
  });
  const partial = ANSWER_PARTIAL.exec(text);
  if (partial && partial[0].length > 1) text = text.slice(0, partial.index);
  return { text, reports, carry: partial && partial[0].length > 1 ? partial[0] : '' };
}

export type BackgroundProbe = Readonly<{
  /** Writes the query and resolves with the reported background (`#RRGGBB`), or null when DA1 came first, `limitMs` passed or Ctrl+C was typed. */
  ask: (write: (query: string) => void, limitMs: number) => Promise<string | null>;
  /** Hears each DEC 2031 notice. */
  onPaletteNotice: (listener: () => void) => () => void;
}>;

/** One probe at a time; answers that arrive with no probe open are dropped (the theme chosen at start-up stays). */
export function createBackgroundProbe(): Readonly<{ probe: BackgroundProbe; report: (report: ColorReport) => void; interrupt: () => void }> {
  const listeners = new Set<() => void>();
  let open: { color: string | null; settle: (color: string | null) => void } | null = null;
  const finish = (color: string | null) => { const current = open; open = null; current?.settle(color); };
  return {
    probe: {
      ask: (write, limitMs) => {
        if (open) return Promise.resolve(null);
        return new Promise(resolve => {
          const timer = setTimeout(() => finish(null), limitMs);
          open = { color: null, settle: color => { clearTimeout(timer); resolve(color); } };
          write(BACKGROUND_QUERY);
        });
      },
      onPaletteNotice: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    report: report => {
      if (report.kind === 'palette') { for (const listener of listeners) listener(); return; }
      if (!open) return;
      if (report.kind === 'background') open.color = report.color; else finish(open.color);
    },
    interrupt: () => finish(null),
  };
}
