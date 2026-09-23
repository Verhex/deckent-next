import type { WorkerLivePhase, WorkLedgerWorkerEntry } from './work-ledger.js';

/** Catalog strings for the live worker line; the terminal package never resolves locale text itself. */
export interface WorkerLineLabels {
  /** BCP 47 tag for number formatting (`18.4k` / `18,4k`). */
  readonly numberLocale: string;
  /** `worker {n}` */
  readonly ordinal: string;
  readonly phases: Readonly<Record<WorkerLivePhase, string>>;
  /** `{n} s`, `{n} min`, `{n} h` */
  readonly durationSeconds: string;
  readonly durationMinutes: string;
  readonly durationHours: string;
  /** `{duration} ago` */
  readonly ago: string;
  /** `{tokens} tokens` and `{tokens} tokens (cache {ratio}%)` */
  readonly tokens: string;
  readonly tokensCache: string;
  /** `{phase} (worker reported)` — a worker-reported outcome is evidence, never acceptance. */
  readonly reported: string;
  readonly eventsTruncated: string;
  /** `{count} events dropped` */
  readonly dropped: string;
  /** `{count} provider events not itemized yet` — a provider normalizer gap, not an error. */
  readonly unmapped: string;
}

export type WorkerLineTone = 'normal' | 'muted' | 'error';
export type WorkerLine = Readonly<{ text: string; tone: WorkerLineTone }>;

const DETAIL_MAX = 60;

export function fillTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

function number(value: number, locale: string, digits: number): string {
  try { return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value); }
  catch { return value.toFixed(digits).replace(/\.0+$/, ''); }
}

/** Compact token count: 950, 18.4k, 1.2M (locale decimal separator). */
export function compactCount(value: number, locale: string): string {
  if (value < 1000) return number(value, locale, 0);
  if (value < 1_000_000) return `${number(Math.floor(value / 100) / 10, locale, 1)}k`;
  return `${number(Math.floor(value / 100_000) / 10, locale, 1)}M`;
}

export function formatDuration(ms: number, labels: Pick<WorkerLineLabels, 'durationSeconds' | 'durationMinutes' | 'durationHours'>): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return fillTemplate(labels.durationSeconds, { n: seconds });
  if (seconds < 3600) return fillTemplate(labels.durationMinutes, { n: Math.floor(seconds / 60) });
  return fillTemplate(labels.durationHours, { n: Math.floor(seconds / 3600) });
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

function activityText(entry: WorkLedgerWorkerEntry, labels: WorkerLineLabels): string {
  const live = entry.live;
  if (!live?.phase) return entry.process;
  const phase = labels.phases[live.phase];
  if (live.phase === 'finished' || live.phase === 'failed') return fillTemplate(labels.reported, { phase });
  if (live.phase === 'starting') return phase;
  const subject = live.target ?? (live.detail ? clip(live.detail) : null);
  return subject ? `${phase} ${subject}` : phase;
}

/**
 * One human-readable line per worker: `worker 2 · claude <model> · editing src/x.ts · 12 s ago · 18.4k tokens (cache 83%)`.
 * Pure: the age is measured on the host clock between the observation (`observedAtMs`) and the last received event.
 */
export function formatWorkerLine(entry: WorkLedgerWorkerEntry, labels: WorkerLineLabels): WorkerLine {
  const live = entry.live ?? null;
  const parts: string[] = [];
  parts.push(entry.ordinal === undefined ? entry.taskId : fillTemplate(labels.ordinal, { n: entry.ordinal }));
  const provider = entry.provider === 'unknown' && live?.provider ? live.provider : entry.provider;
  parts.push(live?.model ? `${provider} ${live.model}` : provider);
  parts.push(activityText(entry, labels));
  if (live?.receivedAt != null && entry.observedAtMs !== undefined) {
    parts.push(fillTemplate(labels.ago, { duration: formatDuration(entry.observedAtMs - live.receivedAt, labels) }));
  }
  if (live?.tokens) {
    const tokens = compactCount(live.tokens, labels.numberLocale);
    parts.push(live.cacheReadRatio === null ? fillTemplate(labels.tokens, { tokens })
      : fillTemplate(labels.tokensCache, { tokens, ratio: Math.round(live.cacheReadRatio * 100) }));
  }
  if (live?.phase === 'starting' && live.unmapped > 0) parts.push(fillTemplate(labels.unmapped, { count: live.unmapped }));
  if (live?.eventsTruncated) parts.push(labels.eventsTruncated);
  if (live && live.dropped > 0) parts.push(fillTemplate(labels.dropped, { count: live.dropped }));
  const tone: WorkerLineTone = live?.phase === 'failed' ? 'error' : !live?.phase || live.phase === 'starting' ? 'muted' : 'normal';
  return Object.freeze({ text: parts.join(' · '), tone });
}
