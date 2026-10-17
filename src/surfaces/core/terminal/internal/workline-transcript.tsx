import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { renderToString } from 'ink';
import type { ViewportBlocks } from '#surfaces/core/terminal-window/index.js';
import type { LedgerRow } from '#surfaces/core/terminal-ledger/index.js';

/**
 * The full-window conversation as viewport blocks (TERMINAL-SABIT-DUZEN): each finished ledger row is laid out once per width with Ink's
 * synchronous `renderToString` — the same component and providers `Static` used — and cached by its sequence number, so the viewport lays
 * out only the rows it shows and a resize re-lays out lazily. `renderToString` runs its own reconciler pass, which must never nest inside a
 * render of the live view: a row the viewport asks for is a one-line placeholder in that render and is laid out right after it, outside
 * React's call stack, and the view renders again. `banner`: the opening frame as the first block (until `/clear`).
 */
export type TranscriptRender = (row: LedgerRow) => ReactElement;
export type TranscriptBlocks = ViewportBlocks & Readonly<{ text: () => string }>;

type Laid = Readonly<{ columns: number; style: unknown; lines: readonly string[] }>;
const BANNER_KEY = 'banner', BANNER_SEQ = -1, PLACEHOLDER: readonly string[] = Object.freeze(['']);

export function splitRendered(text: string): readonly string[] {
  const lines = text.split('\n');
  while (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return Object.freeze(lines);
}

export function useTranscriptBlocks(rows: readonly LedgerRow[], columns: number, render: TranscriptRender, banner: ((columns: number) => string) | null, styleKey: unknown): TranscriptBlocks {
  const cache = useRef(new Map<number, Laid>()), wanted = useRef(new Map<number, Readonly<{ columns: number; style: unknown; draw: () => string }>>());
  const renderRef = useRef(render); renderRef.current = render;
  const [version, setVersion] = useState(0);
  const blocks = useMemo(() => {
    const first = rows[0]?.seq ?? Number.MAX_SAFE_INTEGER;
    for (const seq of cache.current.keys()) if (seq < first && seq !== BANNER_SEQ) cache.current.delete(seq);
    const width = Math.max(1, columns), offset = banner ? 1 : 0;
    const keys = Object.freeze([...(banner ? [BANNER_KEY] : []), ...rows.map(row => String(row.seq))]);
    const source = (index: number): Readonly<{ seq: number; draw: () => string }> | null => {
      if (banner && index === 0) return { seq: BANNER_SEQ, draw: () => banner(width) };
      const row = rows[index - offset];
      return row ? { seq: row.seq, draw: () => renderToString(renderRef.current(row), { columns: width }) } : null;
    };
    const fresh = (seq: number) => { const hit = cache.current.get(seq); return hit && hit.columns === width && hit.style === styleKey ? hit.lines : null; };
    const linesOf = (index: number): readonly string[] => {
      const item = source(index);
      if (!item) return [];
      const hit = fresh(item.seq);
      if (hit) return hit;
      wanted.current.set(item.seq, { columns: width, style: styleKey, draw: item.draw });
      return PLACEHOLDER;
    };
    // After the view closed (outside any render): lay out whatever is still missing, synchronously.
    const text = () => keys.map((_, index) => {
      const item = source(index);
      if (!item) return '';
      return (fresh(item.seq) ?? splitRendered(item.draw())).join('\n');
    }).join('\n');
    void version;
    return Object.freeze({ keys, linesOf, text });
  }, [rows, columns, banner, styleKey, version]);
  useEffect(() => {
    if (wanted.current.size === 0) return undefined;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      for (const [seq, { columns: width, style, draw }] of wanted.current) cache.current.set(seq, { columns: width, style, lines: splitRendered(draw()) });
      wanted.current.clear();
      setVersion(value => value + 1);
    });
    return () => { cancelled = true; };
  });
  return blocks;
}
