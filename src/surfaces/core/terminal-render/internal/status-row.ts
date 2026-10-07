import { PERMISSION_MODES, type PermissionMode } from '#domain/index.js';
import type { SpanRole } from './spans.js';
import { cells, truncateEnd, truncateStart } from './text-width.js';

/**
 * Width-aware status row (behavior of legacy repl/status-row fitStatusRow, f18d53fb8): measured in display cells,
 * optional facts dropped lowest priority first, the scope tail-truncated with a leading ellipsis, never wrapped.
 */
export type StatusSegment = Readonly<{ id: string; text: string; role: SpanRole | null; priority: number; droppable: boolean; shrink: boolean; bold?: boolean }>;
export type StatusRowLayout = Readonly<{ segments: readonly StatusSegment[]; dropped: readonly string[] }>;

const MIN_SHRINK_CELLS = 12;

const rowCells = (segments: readonly StatusSegment[], separator: string): number =>
  segments.reduce((sum, segment) => sum + cells(segment.text), 0) + cells(separator) * Math.max(0, segments.length - 1);

export function fitStatusRow(input: readonly StatusSegment[], columns: number, separator: string, ellipsis: string): StatusRowLayout {
  const budget = Math.max(1, Math.floor(columns));
  let segments = [...input];
  const dropped: string[] = [];
  const shrinkable = () => segments.find(segment => segment.shrink);
  const slack = () => { const item = shrinkable(); return item ? Math.max(0, cells(item.text) - MIN_SHRINK_CELLS) : 0; };
  // 1. Drop optional facts (lowest priority first) until shrinking the scope to its minimum is enough.
  for (const candidate of [...segments].filter(segment => segment.droppable).sort((a, b) => a.priority - b.priority)) {
    if (rowCells(segments, separator) - slack() <= budget) break;
    segments = segments.filter(segment => segment !== candidate);
    dropped.push(candidate.id);
  }
  // 2. Tail-truncate the scope into what is left (the end of an id or path is the informative part).
  const over = rowCells(segments, separator) - budget;
  const target = shrinkable();
  if (over > 0 && target) {
    const text = truncateStart(target.text, Math.max(1, cells(target.text) - over), ellipsis);
    segments = segments.map(segment => segment === target ? { ...segment, text } : segment);
  }
  // 3. Last-resort guard for a physically tiny terminal: keep whole segments that fit, cut the next one.
  if (rowCells(segments, separator) > budget) {
    const kept: StatusSegment[] = [];
    let used = 0;
    for (const segment of segments) {
      const gap = kept.length ? cells(separator) : 0, width = cells(segment.text);
      if (used + gap + width <= budget) { kept.push(segment); used += gap + width; continue; }
      const room = budget - used - gap;
      if (room > 0) kept.push({ ...segment, text: truncateEnd(segment.text, room, ellipsis) });
      break;
    }
    segments = kept;
  }
  return Object.freeze({ segments: Object.freeze(segments), dropped: Object.freeze(dropped) });
}

export function fillTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/** `cancelHint` (TL-A D5) is optional until the catalog carries `terminal.render.cancelHint` (`i18n-delta.json`); neutral text meanwhile. */
export type WorklineStatusLabels = Readonly<{ queued: string; elapsed: string; cancelHint?: string; selfSourceFloor?: string | undefined;
  /** T2 T-MODE-CYCLE: the word of each permission-mode stop; without it the segment is the bare catalog mode (the MODES-3 row). */
  modeStops?: Readonly<Record<PermissionModeStop, string>> | undefined }>;
/** The stops the status row can show (`ask-edits` is standart with the person's "ask for edits too" preference). */
export type PermissionModeStop = PermissionMode | 'ask-edits';
const NEUTRAL_CANCEL_HINT = 'Esc cancels';
export type WorklineStatusInput = Readonly<{
  scope: string; model?: string | undefined; state: string; busy: boolean; spinner?: string | undefined; elapsedMs?: number | undefined;
  queued?: number | undefined; notice?: string | undefined; labels: WorklineStatusLabels;
  /** The person's permission mode from the service (T-L4 slice 4c); shown only as its catalog text, never free text. */
  mode?: PermissionMode | undefined;
  /** Derived repository identity; no setting or authority is inferred from this display fact. */
  selfSource?: boolean | undefined;
  /** A running turn that Esc (or Ctrl+C) cancels now (TL-A D5): the row says so while it runs. */
  cancellable?: boolean | undefined;
  /** T2: the session's stop (with `labels.modeStops`) and its mark; the text is `mark word`, the word carrying the meaning without colour. */
  stop?: PermissionModeStop | undefined;
  modeMark?: string | undefined;
}>;

/** `mark word` of the session's stop when the labels carry the words; otherwise the catalog mode itself (MODES-3). */
function modeText(input: WorklineStatusInput, mode: PermissionMode): string {
  const stop = input.stop === 'ask-edits' && mode === 'standart' ? 'ask-edits' : mode;
  const word = input.labels.modeStops?.[stop];
  return word === undefined ? mode : input.modeMark ? `${input.modeMark} ${word}` : word;
}

/** Display order scope · model · state · cancel · mode · elapsed · queue · notice; drop order notice → cancel → elapsed → mode → model → queue. */
export function worklineStatusSegments(input: WorklineStatusInput): StatusSegment[] {
  const segment = (id: string, text: string, role: SpanRole | null, priority: number, droppable = true, shrink = false): StatusSegment =>
    Object.freeze({ id, text, role, priority, droppable, shrink });
  const state = input.busy && input.spinner ? `${input.spinner} ${input.state}` : input.state;
  // The segment text is the catalog value itself; anything outside the catalog shows no mode at all.
  const mode = PERMISSION_MODES.find(value => value === input.mode);
  return [
    segment('scope', input.scope, 'accent', 90, false, true),
    ...(input.model ? [segment('model', input.model, 'code', 60)] : []),
    segment('state', state, input.busy ? 'success' : 'muted', 100, false),
    ...(input.busy && input.cancellable ? [segment('cancel', input.labels.cancelHint ?? NEUTRAL_CANCEL_HINT, 'muted', 45)] : []),
    // Full access is a standing warning (T3 L4, owner 2026-10-07: mark, word and the warning tone together, bold); a derived source marker also
    // keeps its mode, which names the full-access exception.
    ...(mode ? [mode === 'full-access' ? Object.freeze({ ...segment('mode', modeText(input, mode), 'warning', 95, false), bold: true })
      : segment('mode', modeText(input, mode), mode === 'standart' ? 'muted' : 'modeIndicator', 55, !input.selfSource)] : []),
    ...(input.selfSource && input.labels.selfSourceFloor ? [segment('self-source', input.labels.selfSourceFloor, 'warning', 96, false)] : []),
    ...(input.busy && input.elapsedMs !== undefined ? [segment('elapsed', fillTemplate(input.labels.elapsed, { seconds: Math.floor(input.elapsedMs / 1000) }), 'muted', 50)] : []),
    ...(input.queued ? [segment('queue', fillTemplate(input.labels.queued, { count: input.queued }), 'warning', 70)] : []),
    ...(input.notice ? [segment('notice', input.notice, 'warning', 40)] : []),
  ];
}
