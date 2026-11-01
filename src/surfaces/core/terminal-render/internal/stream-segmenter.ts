import { isTableSeparator } from './table.js';
import { markdownBlock, markdownSpaceBefore, type MarkdownBlock } from './markdown.js';

/**
 * Streamed markdown → finished units (behavior of legacy repl/stream-segmenter). Completed units go to Ink `Static`
 * scrollback as soon as they finish so the dynamic region only holds the unfinished tail. Prose, list, quote and heading
 * lines are independent units (each renders on its own); fenced code and tables are emitted whole. A fence that never
 * closes is shown live in the tail, chunked into scrollback past `FENCE_CHUNK_LINES` (staying in code mode so the real
 * closing fence still closes it — legacy REPL-575 K7) and flushed on `done`; it never freezes the answer (b676d3090).
 */
export type SegmentKind = 'text' | 'code' | 'table';
export type Segment = Readonly<{ kind: SegmentKind; markdown: string; spaceBefore?: true }>;
export type SegmenterState = Readonly<{
  partial: string;
  mode: 'prose' | 'code' | 'table';
  block: readonly string[];
  fence: string | null;
  lastBlank: boolean;
  previous: MarkdownBlock | null;
  fenceChunk: boolean;
}>;
export type SegmenterStep = Readonly<{ state: SegmenterState; segments: readonly Segment[] }>;
export type LiveTail = Readonly<{ markdown: string; open: 'code' | 'table' | null; spaceBefore?: true }>;

export const FENCE_CHUNK_LINES = 200;
export const EMPTY_SEGMENTER: SegmenterState = Object.freeze({ partial: '', mode: 'prose', block: Object.freeze([]), fence: null, lastBlank: false, previous: null, fenceChunk: false });

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

function closesFence(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && trimmed[0] === fence[0] && /^(`+|~+)$/.test(trimmed);
}

interface Draft { mode: SegmenterState['mode']; block: string[]; fence: string | null; lastBlank: boolean; previous: MarkdownBlock | null; fenceChunk: boolean; out: Segment[] }

function emitText(draft: Draft, line: string): void {
  const blank = line.trim() === '';
  if (blank) { draft.lastBlank = true; return; }
  const current = markdownBlock(line, draft.previous), spaceBefore = markdownSpaceBefore(draft.previous, current, draft.lastBlank);
  draft.lastBlank = false; draft.previous = current;
  const last = draft.out.at(-1);
  // A continuation printed on its own has no list marker: don't merge a later item into that renderer context.
  if (last?.kind === 'text' && !spaceBefore && markdownBlock(last.markdown.split('\n', 1)[0]!) === current) draft.out[draft.out.length - 1] = { ...last, markdown: `${last.markdown}\n${line}` };
  else draft.out.push({ kind: 'text', markdown: line, ...(spaceBefore ? { spaceBefore: true } : {}) });
}

function emitBlock(draft: Draft, kind: 'code' | 'table', lines: readonly string[], continuation = false): void {
  const spaceBefore = !continuation && markdownSpaceBefore(draft.previous, kind, draft.lastBlank);
  draft.out.push({ kind, markdown: lines.join('\n'), ...(spaceBefore ? { spaceBefore: true } : {}) });
  draft.lastBlank = false; draft.previous = kind;
}

function closeTable(draft: Draft): void {
  if (draft.block.length === 1) emitText(draft, draft.block[0]!);
  else if (draft.block.length > 1) emitBlock(draft, 'table', draft.block);
  draft.block = []; draft.mode = 'prose';
}

function handleLine(draft: Draft, line: string): void {
  if (draft.mode === 'code') {
    draft.block.push(line);
    if (closesFence(line, draft.fence!)) { emitBlock(draft, 'code', draft.block, draft.fenceChunk); draft.fenceChunk = false; draft.block = []; draft.mode = 'prose'; draft.fence = null; return; }
    if (draft.block.length >= FENCE_CHUNK_LINES) {
      const opening = draft.block[0]!;
      emitBlock(draft, 'code', [...draft.block, draft.fence!], draft.fenceChunk);
      draft.fenceChunk = true;
      draft.block = [opening];
    }
    return;
  }
  if (draft.mode === 'table') {
    // A table is only confirmed by its separator row; otherwise the candidate line was prose (at most one line of delay).
    if (draft.block.length === 1 && !isTableSeparator(line)) closeTable(draft);
    else if (line.includes('|') && line.trim() !== '') { draft.block.push(line); return; }
    else closeTable(draft);
  }
  const fence = FENCE_OPEN.exec(line);
  if (fence) { draft.mode = 'code'; draft.fence = fence[1]!; draft.block = [line]; return; }
  if (line.includes('|') && line.trim() !== '') { draft.mode = 'table'; draft.block = [line]; return; }
  emitText(draft, line);
}

function draftOf(state: SegmenterState): Draft {
  return { mode: state.mode, block: [...state.block], fence: state.fence, lastBlank: state.lastBlank, previous: state.previous, fenceChunk: state.fenceChunk, out: [] };
}

function freeze(draft: Draft, partial: string): SegmenterStep {
  return Object.freeze({
    state: Object.freeze({ partial, mode: draft.mode, block: Object.freeze(draft.block), fence: draft.fence, lastBlank: draft.lastBlank, previous: draft.previous, fenceChunk: draft.fenceChunk }),
    segments: Object.freeze(draft.out.map(segment => Object.freeze(segment))),
  });
}

/** Feeds streamed text; returns only the units this chunk finished. Carriage returns are normalized. */
export function feedSegmenter(state: SegmenterState, chunk: string): SegmenterStep {
  const draft = draftOf(state);
  // Hold a trailing CR until the next chunk (or flush), so a split CRLF never becomes a paragraph break.
  let buffer = (state.partial + chunk).replace(/\r\n|\r(?!$)/g, '\n');
  let newline: number;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    handleLine(draft, buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
  }
  return freeze(draft, buffer);
}

/** End of the answer: the unfinished line and any open block (including an unclosed fence) become finished units. */
export function flushSegmenter(state: SegmenterState): SegmenterStep {
  const draft = draftOf(state);
  if (state.partial !== '') handleLine(draft, state.partial.replace(/\r$/, ''));
  if (draft.mode === 'code' && draft.block.length > 0) emitBlock(draft, 'code', draft.block, draft.fenceChunk);
  else if (draft.mode === 'table') closeTable(draft);
  draft.mode = 'prose'; draft.block = []; draft.fence = null; draft.fenceChunk = false;
  return freeze(draft, '');
}

/** The unfinished part for the small live region: an open code/table block plus the current partial line. */
export function segmenterTail(state: SegmenterState): LiveTail {
  const lines = state.partial === '' ? state.block : [...state.block, state.partial];
  const markdown = lines.join('\n'), first = lines[0] ?? '';
  const current = state.mode === 'code' || FENCE_OPEN.test(first) ? 'code'
    : state.mode === 'table' && isTableSeparator(lines[1] ?? '') ? 'table' : markdownBlock(first, state.previous);
  const spaceBefore = markdown.trim() !== '' && !state.fenceChunk && markdownSpaceBefore(state.previous, current, state.lastBlank);
  return Object.freeze({ markdown, open: state.mode === 'prose' ? null : state.mode, ...(spaceBefore ? { spaceBefore: true } : {}) });
}
