/**
 * Ink key event -> composer key. Readline/emacs bindings as the legacy composer and common shells use them.
 * Ink reports Ctrl+letter as the letter with `ctrl`, Alt+letter as the letter with `meta`, Alt+Enter as `return`
 * with `meta`, Ctrl+J as a bare "\n", and Ctrl/Alt+arrows with the modifier flag set.
 */
import type { Key } from 'ink';
import type { ComposerKey } from './reducer.js';

const CTRL: Readonly<Record<string, ComposerKey>> = {
  a: { type: 'move', to: 'home' }, e: { type: 'move', to: 'end' }, b: { type: 'move', to: 'left' }, f: { type: 'move', to: 'right' },
  p: { type: 'move', to: 'up' }, n: { type: 'move', to: 'down' }, w: { type: 'delete', span: 'spaceWordBack' },
  u: { type: 'delete', span: 'toStart' }, k: { type: 'delete', span: 'toEnd' }, y: { type: 'yank' }, c: { type: 'interrupt' },
  d: { type: 'eof' }, r: { type: 'search' }, g: { type: 'escape' },
};
const META: Readonly<Record<string, ComposerKey>> = {
  b: { type: 'move', to: 'wordLeft' }, f: { type: 'move', to: 'wordRight' }, d: { type: 'delete', span: 'wordForward' },
};

export function composerKey(input: string, key: Key): ComposerKey | null {
  const word = key.ctrl || key.meta;
  if (key.return) return key.shift || key.meta ? { type: 'newline' } : { type: 'submit' };
  if (input === '\n') return { type: 'newline' };
  if (key.tab) return key.shift ? null : { type: 'tab' };
  if (key.escape) return { type: 'escape' };
  if (key.backspace) return { type: 'delete', span: key.meta ? 'wordBack' : 'back' };
  if (key.delete) return { type: 'delete', span: word ? 'wordForward' : 'forward' };
  if (key.leftArrow) return { type: 'move', to: word ? 'wordLeft' : 'left' };
  if (key.rightArrow) return { type: 'move', to: word ? 'wordRight' : 'right' };
  if (key.upArrow) return { type: 'move', to: 'up' };
  if (key.downArrow) return { type: 'move', to: 'down' };
  if (key.home) return { type: 'move', to: 'home' };
  if (key.end) return { type: 'move', to: 'end' };
  if (key.ctrl) return CTRL[input] ?? null;
  if (key.meta) return META[input] ?? null;
  return input ? { type: 'text', text: input } : null;
}
