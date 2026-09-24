import { createContext, useContext } from 'react';

/** Deckent-owned decoration only; model text is never rewritten through this set. */
export type RenderGlyphs = Readonly<{
  ascii: boolean; assistant: string; bullet: string; quote: string; horizontal: string; separator: string; ellipsis: string;
  codeTop: string; codeRail: string; codeBottom: string; spinner: readonly string[];
  table: Readonly<{ top: readonly [string, string, string]; mid: readonly [string, string, string]; bottom: readonly [string, string, string]; edge: string }>;
}>;

const UNICODE: RenderGlyphs = Object.freeze({
  ascii: false, assistant: '●', bullet: '•', quote: '▌', horizontal: '─', separator: '·', ellipsis: '…',
  codeTop: '╭─', codeRail: '│', codeBottom: '╰─', spinner: Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']),
  table: Object.freeze({ top: ['┌', '┬', '┐'] as const, mid: ['├', '┼', '┤'] as const, bottom: ['└', '┴', '┘'] as const, edge: '│' }),
});

const ASCII: RenderGlyphs = Object.freeze({
  ascii: true, assistant: '*', bullet: '-', quote: '|', horizontal: '-', separator: '|', ellipsis: '...',
  codeTop: '+-', codeRail: '|', codeBottom: '+-', spinner: Object.freeze(['|', '/', '-', '\\']),
  table: Object.freeze({ top: ['+', '+', '+'] as const, mid: ['+', '+', '+'] as const, bottom: ['+', '+', '+'] as const, edge: '|' }),
});

export function resolveRenderGlyphs(ascii: boolean): RenderGlyphs {
  return ascii ? ASCII : UNICODE;
}

/** ASCII decoration for terminals that cannot be assumed to draw Unicode (Linux console, dumb, non-UTF-8 locale). */
export function prefersAsciiGlyphs(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env['TERM'] === 'linux' || env['TERM'] === 'dumb') return true;
  const locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '';
  return locale !== '' && !/utf-?8/i.test(locale);
}

export const RenderGlyphsContext = createContext<RenderGlyphs>(UNICODE);

export function useRenderGlyphs(): RenderGlyphs {
  return useContext(RenderGlyphsContext);
}
