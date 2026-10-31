/**
 * Ink key event -> composer key. Readline/emacs bindings as the legacy composer and common shells use them.
 * Ink reports Ctrl+letter as the letter with `ctrl`, Alt+letter as the letter with `meta`, Alt+Enter as `return`
 * with `meta`, Ctrl+J as a bare "\n", and Ctrl/Alt+arrows with the modifier flag set.
 */
import type { Key } from 'ink';
import type { ComposerKey } from './reducer.js';

const CTRL: Readonly<Record<string, ComposerKey>> = {
  a: { type: 'move', to: 'home' }, e: { type: 'move', to: 'end' }, b: { type: 'move', to: 'left' }, f: { type: 'move', to: 'right' },
  p: { type: 'move', to: 'up' }, n: { type: 'move', to: 'down' }, w: { type: 'delete', span: 'spaceWordBack' }, s: { type: 'stash' },
  u: { type: 'delete', span: 'toStart' }, k: { type: 'delete', span: 'toEnd' }, y: { type: 'yank' }, c: { type: 'interrupt' },
  d: { type: 'eof' }, r: { type: 'search' },
  // T4: Ctrl+G opens the draft in the person's editor (Claude Code, Codex); a composer without an editor keeps it the Esc it was.
  g: { type: 'editor' },
  // Ctrl+J is a bare "\n" in a legacy terminal; under the kitty keyboard protocol it arrives as the letter with Ctrl and stays a new line.
  j: { type: 'newline' },
};
const META: Readonly<Record<string, ComposerKey>> = {
  b: { type: 'move', to: 'wordLeft' }, f: { type: 'move', to: 'wordRight' }, d: { type: 'delete', span: 'wordForward' },
};

export function composerKey(input: string, key: Key): ComposerKey | null {
  // Ink 7.1.1 asks the terminal for the kitty keyboard protocol (CSI ? u) and its input handler also reads the answer (CSI ? flags u): an
  // answer, never typed text.
  if (/^\[\?\d*u$/u.test(input)) return null;
  const word = key.ctrl || key.meta;
  // Owner S5: Ctrl+Enter (kitty keyboard protocol) adds the line to a running turn; Alt+Enter does the same where Ctrl+Enter is a plain Enter.
  // Without a running turn the reducer keeps their old meaning: Ctrl+Enter sends, Alt+Enter is a new line.
  if (key.return) return key.ctrl || (key.meta && !key.shift) ? { type: 'steer', via: key.ctrl ? 'ctrl' : 'alt' } : key.shift ? { type: 'newline' } : { type: 'submit' };
  // Ctrl+_ (0x1f; Ctrl+/ on many terminals) undoes the last unsent edit (harness gap 3).
  if (input === '\u001f' || (key.ctrl && (input === '_' || input === '/'))) return { type: 'undo' };
  if (input === '\n') return { type: 'newline' };
  if (key.tab) return key.shift ? null : { type: 'tab' };
  if (key.escape) return { type: 'escape' };
  if (key.backspace) return { type: 'delete', span: key.meta ? 'wordBack' : 'back' };
  if (key.delete) return { type: 'delete', span: word ? 'wordForward' : 'forward' };
  if (key.leftArrow) return { type: 'move', to: word ? 'wordLeft' : 'left' };
  if (key.rightArrow) return { type: 'move', to: word ? 'wordRight' : 'right' };
  // Ctrl+Up / Ctrl+Down jump between the person's messages in the full-window conversation (harness gap 4); plain arrows stay composer keys.
  // T3: Alt+Up takes the last queued message back into an empty draft (Codex); Ink reports ESC[1;3A and ESC ESC[A with `meta`.
  if (key.upArrow && key.meta && !key.ctrl) return { type: 'withdraw' };
  if (key.upArrow && !key.ctrl) return { type: 'move', to: 'up' };
  if (key.downArrow && !key.ctrl) return { type: 'move', to: 'down' };
  // Ctrl+Home / Ctrl+End scroll the full-window conversation (TERMINAL-SABIT-DUZEN); plain Home/End stay line moves.
  if (key.home && !key.ctrl) return { type: 'move', to: 'home' };
  if (key.end && !key.ctrl) return { type: 'move', to: 'end' };
  if (key.ctrl) return CTRL[input] ?? null;
  if (key.meta) return META[input] ?? null;
  return input ? { type: 'text', text: input } : null;
}
