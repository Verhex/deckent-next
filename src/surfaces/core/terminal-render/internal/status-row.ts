import type { SpanRole } from './spans.js';
import { cells, truncateEnd, truncateStart } from './text-width.js';

/**
 * Width-aware status row (behavior of legacy repl/status-row fitStatusRow, f18d53fb8): measured in display cells,
 * optional facts dropped lowest priority first, the scope tail-truncated with a leading ellipsis, never wrapped.
 */
export type StatusSegment = Readonly<{ id: string; text: string; role: SpanRole | null; priority: number; droppable: boolean; shrink: boolean }>;
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

export type WorklineStatusLabels = Readonly<{ queued: string; elapsed: string }>;
export type WorklineStatusInput = Readonly<{
  scope: string; model?: string | undefined; state: string; busy: boolean; spinner?: string | undefined; elapsedMs?: number | undefined;
  queued?: number | undefined; notice?: string | undefined; labels: WorklineStatusLabels;
}>;

/** Display order scope · model · state · elapsed · queue · notice; drop order notice → elapsed → model → queue. */
export function worklineStatusSegments(input: WorklineStatusInput): StatusSegment[] {
  const segment = (id: string, text: string, role: SpanRole | null, priority: number, droppable = true, shrink = false): StatusSegment =>
    Object.freeze({ id, text, role, priority, droppable, shrink });
  const state = input.busy && input.spinner ? `${input.spinner} ${input.state}` : input.state;
  return [
    segment('scope', input.scope, 'accent', 90, false, true),
    ...(input.model ? [segment('model', input.model, 'code', 60)] : []),
    segment('state', state, input.busy ? 'success' : 'muted', 100, false),
    ...(input.busy && input.elapsedMs !== undefined ? [segment('elapsed', fillTemplate(input.labels.elapsed, { seconds: Math.floor(input.elapsedMs / 1000) }), 'muted', 50)] : []),
    ...(input.queued ? [segment('queue', fillTemplate(input.labels.queued, { count: input.queued }), 'warning', 70)] : []),
    ...(input.notice ? [segment('notice', input.notice, 'warning', 40)] : []),
  ];
}
