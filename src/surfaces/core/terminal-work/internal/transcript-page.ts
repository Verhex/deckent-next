import { fillTemplate } from '#surfaces/core/terminal-ledger/index.js';

/** Lines of one `/transcript` page. A fixed bound of the screen, not a policy: page 1 is the newest lines, a later page reaches further back. */
export const TRANSCRIPT_PAGE_LINES = 40;

/** Catalog strings of one transcript page; `{from}`–`{to}` of `{total}`, page `{page}` of `{pages}`, `{ref}` the worker as typed, `{next}` the earlier page. */
export interface TranscriptPageLabels { readonly more: string; readonly end: string; readonly range: string }

export type TranscriptPage = Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; text: string }>;

/** The newest `TRANSCRIPT_PAGE_LINES` lines (page 1) or an earlier page, with a footer that says where the rest is. A text that fits one page is returned whole. */
export function transcriptPage(text: string, page: number, ref: string, labels: TranscriptPageLabels): TranscriptPage {
  const lines = text.split('\n'), total = lines.length, pages = Math.max(1, Math.ceil(total / TRANSCRIPT_PAGE_LINES));
  if (pages === 1 && page === 1) return { ok: true, text };
  if (page > pages) return { ok: false, text: fillTemplate(labels.range, { pages, ref }) };
  const to = total - (page - 1) * TRANSCRIPT_PAGE_LINES, from = Math.max(1, to - TRANSCRIPT_PAGE_LINES + 1);
  const values = { from, to, total, page, pages, ref, next: page + 1 };
  return { ok: true, text: [...lines.slice(from - 1, to), fillTemplate(page < pages ? labels.more : labels.end, values)].join('\n') };
}
