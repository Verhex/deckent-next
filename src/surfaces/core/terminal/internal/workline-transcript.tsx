import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { renderToString } from 'ink';
import type { SearchableBlocks } from '#surfaces/core/terminal-window/index.js';
import type { LedgerRow } from '#surfaces/core/terminal-ledger/index.js';

/**
 * The full-window conversation as viewport blocks (TERMINAL-SABIT-DUZEN): each finished ledger row is laid out once per width with Ink's
 * synchronous `renderToString` — the same component and providers `Static` used — and cached by its sequence number, so the viewport lays
 * out only the rows it shows and a resize re-lays out lazily. `renderToString` runs its own reconciler pass, which must never nest inside a
 * render of the live view: a row the viewport asks for is a one-line placeholder in that render and is laid out right after it, outside
 * React's call stack, and the view renders again. `banner`: the opening frame as the first block (until `/clear`). `variantOf` (alpha.59 L6): how a row
 * shows now (a read group collapsed or expanded by a click), part of its cache key so a click lays out that row alone; `exit` asks for the form
 * written to the main screen when the view closes (every read group open, so its calls reach the scrollback without a click).
 */
export type TranscriptRender = (row: LedgerRow, exit?: boolean) => ReactElement;
export type TranscriptVariant = (row: LedgerRow, exit?: boolean) => string;
export type TranscriptBlocks = SearchableBlocks & Readonly<{ text: () => string }>;

type Laid = Readonly<{ columns: number; style: unknown; variant: string; lines: readonly string[] }>;
const NO_VARIANT: TranscriptVariant = () => '';
const BANNER_KEY = 'banner', BANNER_SEQ = -1, PLACEHOLDER: readonly string[] = Object.freeze(['']);

export function splitRendered(text: string): readonly string[] {
  const lines = text.split('\n');
  while (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return Object.freeze(lines);
}

export function useTranscriptBlocks(rows: readonly LedgerRow[], columns: number, render: TranscriptRender, banner: ((columns: number) => string) | null, styleKey: unknown,
  variantOf: TranscriptVariant = NO_VARIANT): TranscriptBlocks {
  const cache = useRef(new Map<number, Laid>()), wanted = useRef(new Map<number, Readonly<{ columns: number; style: unknown; variant: string; draw: () => string }>>());
  const renderRef = useRef(render); renderRef.current = render;
  const [version, setVersion] = useState(0);
  const blocks = useMemo(() => {
    const first = rows[0]?.seq ?? Number.MAX_SAFE_INTEGER;
    for (const seq of cache.current.keys()) if (seq < first && seq !== BANNER_SEQ) cache.current.delete(seq);
    const width = Math.max(1, columns), offset = banner ? 1 : 0;
    const keys = Object.freeze([...(banner ? [BANNER_KEY] : []), ...rows.map(row => String(row.seq))]);
    const source = (index: number, exit = false): Readonly<{ seq: number; variant: string; draw: () => string }> | null => {
      if (banner && index === 0) return { seq: BANNER_SEQ, variant: '', draw: () => banner(width) };
      const row = rows[index - offset];
      return row ? { seq: row.seq, variant: variantOf(row, exit), draw: () => renderToString(renderRef.current(row, exit), { columns: width }) } : null;
    };
    const fresh = (seq: number, variant: string) => { const hit = cache.current.get(seq); return hit && hit.columns === width && hit.style === styleKey && hit.variant === variant ? hit.lines : null; };
    const linesOf = (index: number): readonly string[] => {
      const item = source(index);
      if (!item) return [];
      const hit = fresh(item.seq, item.variant);
      if (hit) return hit;
      wanted.current.set(item.seq, { columns: width, style: styleKey, variant: item.variant, draw: item.draw });
      return PLACEHOLDER;
    };
    // After the view closed (outside any render): a row laid out at an earlier width is reused as it is (laying out ~2000 rows again costs
    // seconds at exit); only a row never laid out is drawn now.
    const text = () => keys.map((_, index) => {
      const item = source(index, true);
      if (!item) return '';
      const laid = cache.current.get(item.seq);
      return (fresh(item.seq, item.variant) ?? (laid?.variant === item.variant ? laid.lines : null) ?? splitRendered(item.draw())).join('\n');
    }).join('\n');
    // Search (outside any render): a row not laid out yet is laid out now and cached like the viewport's own rows.
    const layout = (index: number): readonly string[] => {
      const item = source(index);
      if (!item) return [];
      const hit = fresh(item.seq, item.variant);
      if (hit) return hit;
      const lines = splitRendered(item.draw());
      cache.current.set(item.seq, { columns: width, style: styleKey, variant: item.variant, lines });
      return lines;
    };
    const isPrompt = (index: number) => { const row = rows[index - offset]; return row !== undefined && row.entry.kind === 'chat' && row.entry.role === 'user'; };
    void version;
    return Object.freeze({ keys, linesOf, text, layout, isPrompt });
  }, [rows, columns, banner, styleKey, variantOf, version]);
  useEffect(() => {
    if (wanted.current.size === 0) return undefined;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      for (const [seq, { columns: width, style, variant, draw }] of wanted.current) cache.current.set(seq, { columns: width, style, variant, lines: splitRendered(draw()) });
      wanted.current.clear();
      setVersion(value => value + 1);
    });
    return () => { cancelled = true; };
  });
  return blocks;
}
