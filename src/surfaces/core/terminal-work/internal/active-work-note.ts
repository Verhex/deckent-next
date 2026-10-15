import type { RunView } from '#engine/index.js';
import type { ActiveDelivery, ActiveDo } from './active-work.js';
import type { TrackedRun } from './run-completion.js';

/**
 * NATIVE-BAGLAM item 1 (active work): the session's running `/do`, its waiting deliveries and the Runs it admitted, as the active work strip
 * holds them, told to the model as a bounded note at the end of the person's latest message. Only the latest message gets one and earlier
 * messages keep theirs unchanged, so the prompt prefix stays cacheable (the service prompt never carries volatile run state). The note is
 * descriptive model-facing protocol (English, like the service prompt); its marker lets every display strip it as it strips attachments.
 */
export const ACTIVE_WORK_NOTE_MARK = '\n\n--- deckent session note: active work ';
const MAX_ROWS = 8, MAX_TITLE = 80;
const title = (text: string) => JSON.stringify(text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE)}…` : text);
const elapsed = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`; };
function runState(run: RunView): string {
  if (run.state.kind === 'terminal') return `finished (${run.state.outcome})`;
  if ((run.state.kind === 'parked' && ['needs-input', 'awaiting-decision'].includes(run.state.reason)) || run.tasks.some(task => task.phase === 'awaiting-decision')) return 'needs the person';
  return run.state.kind === 'parked' ? `parked (${run.state.reason})` : run.state.kind;
}

/** The note, or '' when the strip is empty. Rows in the strip's order (the /do, deliveries, then Runs), at most eight, each title bounded. */
export function activeWorkModelNote(input: { readonly active: ActiveDo | null; readonly runs: readonly TrackedRun[]; readonly deliveries?: readonly ActiveDelivery[];
  readonly nowMs: number }): string {
  const rows = [
    ...(input.active ? [`- /do ${title(input.active.title)}: ${input.active.phase === 'planning' ? 'planning' : 'waiting for the person\'s approval'}, ${elapsed(input.nowMs - input.active.sinceMs)}`] : []),
    ...(input.deliveries ?? []).map(delivery => `- delivery ${title(delivery.title)}: waiting for the person's delivery decision (/deliver), ${elapsed(input.nowMs - delivery.sinceMs)}`),
    ...input.runs.map(({ run, sinceMs }) => `- Run ${run.runId} ${title(run.tasks.find(task => task.taskBrief?.task)?.taskBrief?.task ?? 'untitled')}: ${runState(run)}, ${elapsed(input.nowMs - sinceMs)}`),
  ];
  if (!rows.length) return '';
  const shown = rows.slice(0, MAX_ROWS);
  return `${ACTIVE_WORK_NOTE_MARK}(written by the terminal, not by the person; descriptive only) ---\n${shown.join('\n')}${rows.length > shown.length ? `\n- and ${rows.length - shown.length} more (/runs)` : ''}`;
}
/** The text before any session note (what the person typed, attachments included). */
export const withoutActiveWorkNote = (content: string): string => { const at = content.indexOf(ACTIVE_WORK_NOTE_MARK); return at >= 0 ? content.slice(0, at) : content; };
