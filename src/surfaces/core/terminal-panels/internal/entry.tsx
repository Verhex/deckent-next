import { useRef, useState } from 'react';
import { Text, type Key } from 'ink';
import { graphemes, nextBoundary, previousBoundary } from '#surfaces/core/terminal-composer/index.js';
import { span, useRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { Window, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';

/** One edit of a single-line entry (cluster-safe, on the composer's own text primitives): the next text and caret, or null for a key it ignores. */
export type EntryState = Readonly<{ text: string; caret: number }>;
export function editEntry(state: EntryState, input: string, key: Pick<Key, 'backspace' | 'delete' | 'leftArrow' | 'rightArrow' | 'home' | 'end' | 'ctrl' | 'meta'>): EntryState | null {
  const { text, caret } = state;
  if (key.ctrl) return input === 'u' ? { text: text.slice(caret), caret: 0 } : input === 'a' ? { text, caret: 0 } : input === 'e' ? { text, caret: text.length } : null;
  if (key.meta) return null;
  if (key.backspace) { const from = previousBoundary(text, caret); return { text: text.slice(0, from) + text.slice(caret), caret: from }; }
  if (key.delete) return { text: text.slice(0, caret) + text.slice(nextBoundary(text, caret)), caret };
  if (key.leftArrow) return { text, caret: previousBoundary(text, caret) };
  if (key.rightArrow) return { text, caret: nextBoundary(text, caret) };
  if (key.home) return { text, caret: 0 };
  if (key.end) return { text, caret: text.length };
  // One line: line breaks and tabs become spaces; other control characters are dropped.
  const typed = [...input.replace(/[\r\n\t]+/gu, ' ')].filter(char => (char.codePointAt(0) ?? 0) > 0x1f && char !== '\u007f').join('');
  return typed ? { text: text.slice(0, caret) + typed + text.slice(caret), caret: caret + typed.length } : null;
}

/** A masked entry shows one mark per character cluster (the value itself is never drawn); `after`: only what follows its first occurrence. */
export function maskEntry(text: string, mark: string, after?: string): string {
  const at = after === undefined ? 0 : text.indexOf(after);
  if (at < 0) return text;
  const kept = after === undefined ? 0 : at + after.length;
  return text.slice(0, kept) + graphemes(text.slice(kept)).map(() => mark).join('');
}

/**
 * A bounded window with one single-line entry (T3 L4 `/config` free values, the `/mcp` wizard's text steps). Enter submits the text to
 * `onSubmit`, which may answer a localized reason to stay open; Esc and Ctrl+C cancel. `masked` draws marks instead of the value.
 */
export function EntryWindow({ title, body = [], hints, position, masked = false, initial = '', problem: opening = null, onSubmit, onCancel }: {
  readonly title: string; readonly body?: readonly WindowLine[]; readonly hints: string; readonly position: string; readonly initial?: string;
  /** A reason shown under the entry when it opens (the step is shown again because its value was refused). */
  readonly problem?: string | null;
  /** `true`: the whole value; `{ after }`: the value after the first separator (a `NAME=value` pair keeps its name visible). */
  readonly masked?: boolean | Readonly<{ after: string }>;
  readonly onSubmit: (text: string) => string | null | Promise<string | null>; readonly onCancel: () => void;
}) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const [state, setState] = useState<EntryState>({ text: initial, caret: initial.length });
  const [problem, setProblem] = useState<string | null>(opening);
  const live = useRef(state), busy = useRef(false);
  live.current = state;
  const onInput = (input: string, key: Key) => {
    if (busy.current) return true;
    if (key.escape || (key.ctrl && input === 'c')) { onCancel(); return true; }
    if (key.return) {
      busy.current = true;
      // An accepted entry keeps the window deaf: the next step replaces it, and a fast second Enter must not submit it twice.
      void Promise.resolve(onSubmit(live.current.text)).then(reason => { busy.current = reason === null; setProblem(reason); }, () => { busy.current = false; });
      return true;
    }
    const next = editEntry(live.current, input, key);
    if (next) { live.current = next; setState(next); setProblem(null); }
    return true;
  };
  const after = typeof masked === 'object' ? masked.after : undefined, mark = glyphs.ascii ? '*' : '•';
  // The caret is placed in the drawn text: a masked part draws one mark per cluster.
  const shown = masked ? maskEntry(state.text, mark, after) : state.text;
  const at = masked ? maskEntry(state.text.slice(0, state.caret), mark, after).length : state.caret;
  const caret = glyphs.ascii ? '|' : '▏';
  return <Window title={[span(title)]} body={body} hints={hints} position={position} footerRows={problem ? 2 : 1} onInput={onInput}
    footer={() => <>
      <Text wrap="truncate-start">{`> ${shown.slice(0, at)}${caret}${shown.slice(at)}`}</Text>
      {problem ? <Text {...palette.warning} wrap="wrap">{problem}</Text> : null}
    </>} />;
}
