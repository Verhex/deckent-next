import { isTableSeparator } from './table.js';

/**
 * Streamed markdown → finished units (behavior of legacy repl/stream-segmenter). Completed units go to Ink `Static`
 * scrollback as soon as they finish so the dynamic region only holds the unfinished tail. Prose, list, quote and heading
 * lines are independent units (each renders on its own); fenced code and tables are emitted whole. A fence that never
 * closes is shown live in the tail, chunked into scrollback past `FENCE_CHUNK_LINES` (staying in code mode so the real
 * closing fence still closes it — legacy REPL-575 K7) and flushed on `done`; it never freezes the answer (b676d3090).
 */
export type SegmentKind = 'text' | 'code' | 'table';
export type Segment = Readonly<{ kind: SegmentKind; markdown: string }>;
export type SegmenterState = Readonly<{
  partial: string;
  mode: 'prose' | 'code' | 'table';
  block: readonly string[];
  fence: string | null;
  lastBlank: boolean;
  started: boolean;
}>;
export type SegmenterStep = Readonly<{ state: SegmenterState; segments: readonly Segment[] }>;
export type LiveTail = Readonly<{ markdown: string; open: 'code' | 'table' | null }>;

export const FENCE_CHUNK_LINES = 200;
export const EMPTY_SEGMENTER: SegmenterState = Object.freeze({ partial: '', mode: 'prose', block: Object.freeze([]), fence: null, lastBlank: false, started: false });

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

function closesFence(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && trimmed[0] === fence[0] && /^(`+|~+)$/.test(trimmed);
}

interface Draft { mode: SegmenterState['mode']; block: string[]; fence: string | null; lastBlank: boolean; started: boolean; out: Segment[] }

function emitText(draft: Draft, line: string): void {
  const blank = line.trim() === '';
  if (blank && (draft.lastBlank || !draft.started)) return;
  draft.lastBlank = blank; draft.started = true;
  const last = draft.out.at(-1);
  if (last?.kind === 'text') draft.out[draft.out.length - 1] = { kind: 'text', markdown: `${last.markdown}\n${line}` };
  else draft.out.push({ kind: 'text', markdown: line });
}

function emitBlock(draft: Draft, kind: 'code' | 'table', lines: readonly string[]): void {
  draft.out.push({ kind, markdown: lines.join('\n') });
  draft.lastBlank = false; draft.started = true;
}

function closeTable(draft: Draft): void {
  if (draft.block.length === 1) emitText(draft, draft.block[0]!);
  else if (draft.block.length > 1) emitBlock(draft, 'table', draft.block);
  draft.block = []; draft.mode = 'prose';
}

function handleLine(draft: Draft, line: string): void {
  if (draft.mode === 'code') {
    draft.block.push(line);
    if (closesFence(line, draft.fence!)) { emitBlock(draft, 'code', draft.block); draft.block = []; draft.mode = 'prose'; draft.fence = null; return; }
    if (draft.block.length >= FENCE_CHUNK_LINES) {
      const opening = draft.block[0]!;
      emitBlock(draft, 'code', [...draft.block, draft.fence!]);
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
  return { mode: state.mode, block: [...state.block], fence: state.fence, lastBlank: state.lastBlank, started: state.started, out: [] };
}

function freeze(draft: Draft, partial: string): SegmenterStep {
  return Object.freeze({
    state: Object.freeze({ partial, mode: draft.mode, block: Object.freeze(draft.block), fence: draft.fence, lastBlank: draft.lastBlank, started: draft.started }),
    segments: Object.freeze(draft.out.map(segment => Object.freeze(segment))),
  });
}

/** Feeds streamed text; returns only the units this chunk finished. Carriage returns are normalized. */
export function feedSegmenter(state: SegmenterState, chunk: string): SegmenterStep {
  const draft = draftOf(state);
  let buffer = (state.partial + chunk).replace(/\r\n?/g, '\n');
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
  if (state.partial !== '') handleLine(draft, state.partial);
  if (draft.mode === 'code' && draft.block.length > 0) emitBlock(draft, 'code', draft.block);
  else if (draft.mode === 'table') closeTable(draft);
  draft.mode = 'prose'; draft.block = []; draft.fence = null;
  return freeze(draft, '');
}

/** The unfinished part for the small live region: an open code/table block plus the current partial line. */
export function segmenterTail(state: SegmenterState): LiveTail {
  const lines = state.partial === '' ? state.block : [...state.block, state.partial];
  return Object.freeze({ markdown: lines.join('\n'), open: state.mode === 'prose' ? null : state.mode });
}
