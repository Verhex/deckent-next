import { createContext, useCallback, useContext } from 'react';
import { useStdout, type Key } from 'ink';
import { plainText, type Span } from '#surfaces/core/terminal-render/index.js';

/**
 * Card copy (alpha.59 L3, owner 2026-10-30): Ctrl+Y ("yank", the vi/tmux copy word) sends a card's drawn text to the terminal clipboard.
 * Claude Code's sign-in card copies on a plain `c` and Codex copies on Ctrl+O; here a plain letter is an answer or typed text on some card
 * and Ctrl+O switches focus, so the copy key is the one control key no card, entry or the composer reads. It is never an answer, a witness or
 * an arming event. The write is the host's one clipboard writer (`terminal-host` `clipboardRequest`: byte-capped, TTY-only, tmux-wrapped).
 */
export type CardCopyResult = Readonly<{ ok: true; bytes: number }> | Readonly<{ ok: false; reason: 'empty' | 'too-large' | 'unavailable'; bytes: number }>;
/** Catalog `tuicopy.card.*`: `{count}` characters sent, `{bytes}`/`{max}` of a refused request. */
export type CardCopyLabels = Readonly<{ hint: string; sent: string; tooLarge: string; unavailable: string }>;
export type CardCopy = Readonly<{ write: (text: string) => CardCopyResult; labels: CardCopyLabels; maxBytes: number }>;
/** Absent where no real TTY takes clipboard requests: the cards then neither show nor take the copy key. */
export const CardCopyContext = createContext<CardCopy | null>(null);
/** True where a raw line written now lands in the main screen's scrollback (the full window's alternate screen has none). */
export const MainScreenContext = createContext<boolean>(true);
/** Writes finished lines above the live area into the main screen's scrollback, unbroken (the terminal wraps them softly, so its own click
 * and selection take a whole address); null in the full window, whose alternate screen has no scrollback. The caller makes the text safe. */
export function useMainScreenLine(): ((text: string) => void) | null {
  const mainScreen = useContext(MainScreenContext), { write } = useStdout();
  const line = useCallback((text: string) => write(`${text}\n`), [write]);
  return mainScreen ? line : null;
}

export const isCardCopyKey = (input: string, key: Key): boolean => key.ctrl && !key.meta && input === 'y';

/** The card's text as drawn, one logical line per body line (a wrapped value is copied whole): title, then `label value` rows. Inputs
 * (an entry, the option rows) are never part of it, so a masked value is never copied. */
export function cardCopyText(title: readonly Span[], body: readonly Readonly<{ label?: readonly Span[]; spans: readonly Span[] }>[]): string {
  return [plainText(title), ...body.map(line => [line.label ? plainText(line.label).trim() : '', plainText(line.spans)].filter(Boolean).join(' '))].join('\n').trim();
}

/** OSC 8 around a drawn link row: only an http(s) address of printable ASCII is ever put in the sequence (no ESC, BEL or space). */
export function hyperlinkEnds(uri: string | undefined): Readonly<{ open: string; close: string }> | null {
  if (!uri || !/^https?:\/\/[\x21-\x7e]+$/u.test(uri)) return null;
  return { open: `\u001b]8;;${uri}\u0007`, close: '\u001b]8;;\u0007' };
}
