import { type WorkLedgerEntry, type WorkLedgerWorkerEntry, type WorkerAttemptIdentity, notice, fillTemplate, type WorklineLedgerPorts, ledgerEntriesForRuns, ledgerEntriesForWorkers, ledgerEntryForRun } from '#surfaces/core/terminal-ledger/index.js';
import type { JobWindowLabels } from './job-windows.js';
import type { RunAnswerLabels, RunControlLabels } from './run-control.js';
import type { ActiveWorkLabels } from './active-work.js';
import type { LiveWindowKind, LiveWindowLabels, WorkerPanelLabels } from './live-windows.js';
import type { ApprovalSurfaceLabels } from '#surfaces/core/terminal-approval/index.js';
import { transcriptPage, type TranscriptPageLabels } from '#surfaces/core/terminal-ledger/index.js';
import { shortId } from '#platform/index.js';
import { slashHelpText, WORKLINE_SLASH_COMMANDS, type SurfaceDeliveryMode } from '#surfaces/core/terminal-kit/index.js';

export interface WorklineActionLabels {
  readonly ledgerUnavailable: string;
  readonly runNotFound: string;
  readonly workersEmpty: string;
  readonly runsEmpty: string;
  readonly serviceRestartUnavailable: string;
  readonly queued: string;
  readonly runUsage: string;
  /** `{mode}` is `push` or `poll`. Present in production; tests omit it unless they assert the mark. */
  readonly watchDelivery?: string;
  /** `{status}` is `gap`, `backpressure` or `foreign-scope`. */
  readonly watchStep?: string;
  readonly watchPushFailed?: string;
  readonly watchNotInitialized?: string; readonly watchAccessDenied?: string;
  readonly watchAccessStopped?: string;
  readonly statusLine: string;
  readonly unknownCommand: string; readonly commandUnavailable?: string;
  /** The same registry-derived labels as the palette; optional for callers without a composer. */
  readonly composer?: { readonly slash: Readonly<Record<string, string>> };
  /** Worker live line, transcript, approvals and run control; absent means those commands are not offered. */
  readonly work?: WorkSurfaceLabels;
}

/** Catalog strings for the work surface (P4). Templates use `{name}` placeholders. */
export interface WorkSurfaceLabels extends ApprovalSurfaceLabels {
  readonly jobs?: JobWindowLabels;
  /** Y1: the Runs window's hold/resume/close keys and cards; absent: `/runs` stays the read-only list. */
  readonly runControl?: RunControlLabels;
  /** BR2: the needs-input answer card (`a` on a Runs window row); absent with `runControl`: no answer key. */
  readonly runAnswer?: RunAnswerLabels;
  /** TERMINAL-SABIT slice 2: the active work strip above the composer; absent means no strip. */
  readonly activeWork?: ActiveWorkLabels;
  /** Live windows (`/monitor`, `/tasks`); absent means those commands are not offered as windows. */
  readonly live?: LiveWindowLabels;
  readonly panel: WorkerPanelLabels;
  readonly unavailable: string;
  readonly transcriptUsage: string;
  readonly transcriptNotFound: string;
  readonly transcriptNoAttempt: string;
  readonly transcriptHeader: string;
  /** Paging of a long transcript; absent means the whole transcript is shown. */
  readonly transcriptPage?: TranscriptPageLabels;
  /** `{task}` and `{attempt}` in full: the headline carries their short forms. */
  readonly transcriptDetail?: string;
  readonly sessionStandingClear?: { readonly cleared: string; readonly unconfirmed: string };
}

export type WatchState = Readonly<{ workers: boolean; runs: boolean }>;

interface WorklineActionContext {
  readonly followDelivery?: SurfaceDeliveryMode;
  readonly ledger: WorklineLedgerPorts | undefined;
  readonly labels: WorklineActionLabels;
  readonly watch: WatchState;
  readonly canRestartService?: boolean;
  /** Poll interval used when the watch has no push port. The delivery line reports this timeout. */
  readonly pollMs?: number;
}

/** Result of one slash command; the view applies it. Entries carry no identity: the ledger buffer assigns sequence ids. */
/** `window`: the live window the command opens. */
type WorklineActionResult = Readonly<{ entries: readonly WorkLedgerEntry[]; watch?: WatchState; window?: Exclude<LiveWindowKind, 'monitor'>; exit?: true }>;

type ImmediateAction = (context: WorklineActionContext, args: string, command: string) => WorklineActionResult | null;
const failed = (text: string): WorklineActionResult => ({ entries: [notice('error', text)] });
const statusLine: ImmediateAction = ({ labels }) => ({ entries: [notice('info', labels.statusLine)] });
const needsLedger: ImmediateAction = ({ ledger, labels }) => ledger ? null : failed(labels.ledgerUnavailable);
const workSurface = (wired: (ledger: WorklineLedgerPorts | undefined) => unknown): ImmediateAction => ({ ledger, labels }) =>
  labels.work && wired(ledger) ? null : failed(labels.work?.unavailable ?? labels.ledgerUnavailable);
const IMMEDIATE: Readonly<Record<string, ImmediateAction | undefined>> = {
  beuser: ({ labels }, _args, command) => failed(fillTemplate(labels.commandUnavailable ?? labels.ledgerUnavailable, { part: command })),
  exit: () => ({ entries: [], exit: true }), quit: () => ({ entries: [], exit: true }), status: statusLine, 'chat-backend': statusLine,
  help: ({ labels }, args) => ({ entries: [notice('info', slashHelpText(labels.composer?.slash ?? {}, WORKLINE_SLASH_COMMANDS, args))] }),
  tasks: ({ ledger, labels, watch }) => {
    if (!ledger || !labels.work?.live) return failed(labels.work?.live ? labels.ledgerUnavailable : (labels.work?.unavailable ?? labels.ledgerUnavailable));
    // `/tasks` follows both feeds (runs only where the ledger can list them); a feed already on is not announced again, its window just opens.
    const next: WatchState = { workers: true, runs: watch.runs || Boolean(ledger.listRunIds) };
    if (next.workers === watch.workers && next.runs === watch.runs) return { entries: [], window: 'tasks' };
    return { entries: [], watch: next, window: 'tasks' };
  },
  runs: ({ ledger, labels }) => ledger?.listRunIds ? null : failed(labels.ledgerUnavailable),
  workers: needsLedger, run: needsLedger,
  'service-restart': ({ canRestartService, labels }) => canRestartService ? null : failed(labels.serviceRestartUnavailable),
  transcript: workSurface(ledger => ledger?.inspectTranscript), approvals: workSurface(ledger => ledger?.listApprovalPage && ledger.decideApproval), cancel: workSurface(ledger => ledger?.cancelRun),
};
/** Pure dispatch for immediate commands; `needsLedger` commands return null and run through `runLedgerCommand`. */
export function immediateSlashAction(command: string, context: WorklineActionContext, args = ''): WorklineActionResult | null {
  const action = Object.hasOwn(IMMEDIATE, command) ? IMMEDIATE[command] : undefined;
  return action ? action(context, args, command) : failed(`${context.labels.unknownCommand}: /${command}`);
}

const workerOrdinal = (ref: string): number | undefined => /^[1-9][0-9]*$/.test(ref) ? Number(ref) : undefined;

/** Resolve a worker number within the supplied list, or an explicit attempt id. */
export function resolveWorkerRef(ref: string, workers: readonly WorkLedgerWorkerEntry[]): WorkLedgerWorkerEntry | null {
  const ordinal = workerOrdinal(ref);
  if (ordinal !== undefined) return workers.find(worker => worker.ordinal === ordinal) ?? null;
  return workers.find(worker => worker.attempt?.attemptId === ref) ?? null;
}

const attemptKey = (attempt: WorkerAttemptIdentity): string =>
  JSON.stringify([attempt.scopeId, attempt.runId, attempt.taskId, attempt.attemptId, attempt.generation, attempt.layoutRevision]);

function workerNumbering(entries: readonly WorkLedgerEntry[], listed: boolean) {
  const attempts = new Map<number, string | null>(), ordinals = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== 'worker' || entry.ordinal === undefined) continue;
    const key = entry.attempt ? attemptKey(entry.attempt) : null;
    attempts.set(entry.ordinal, key);
    if (key !== null && !ordinals.has(key)) ordinals.set(key, entry.ordinal);
  }
  return { listed, attempts, ordinals };
}

// The ledger port identifies the session. A complete list replaces earlier bindings.
const shownWorkerAttempts = new WeakMap<WorklineLedgerPorts, ReturnType<typeof workerNumbering>>();

export function showWorkerNumbering(ledger: WorklineLedgerPorts, entries: readonly WorkLedgerEntry[]): void {
  shownWorkerAttempts.set(ledger, workerNumbering(entries, true));
}

export function presentWorkerRef(ledger: WorklineLedgerPorts, attempt: WorkerAttemptIdentity, ordinal: number | undefined,
  firstObservation: readonly WorkLedgerEntry[] = []): string {
  let shown = shownWorkerAttempts.get(ledger);
  if (!shown) {
    shown = workerNumbering(firstObservation, false);
    shownWorkerAttempts.set(ledger, shown);
  }
  const key = attemptKey(attempt);
  if (ordinal !== undefined && shown.attempts.get(ordinal) === key) return String(ordinal);
  const bound = shown.ordinals.get(key);
  if (bound !== undefined) return String(bound);
  if (ordinal === undefined || shown.listed || shown.attempts.has(ordinal)) return attempt.attemptId;
  shown.attempts.set(ordinal, key);
  shown.ordinals.set(key, ordinal);
  return String(ordinal);
}

/** Read-only: checks the selected Attempt against a fresh observation and shows its sealed transcript. */
async function runTranscript(ref: string, ledger: WorklineLedgerPorts, work: WorkSurfaceLabels): Promise<readonly WorkLedgerEntry[]> {
  const [name, pageText, ...extra] = ref.split(/\s+/u), page = pageText === undefined ? 1 : /^[1-9][0-9]{0,5}$/u.test(pageText) ? Number(pageText) : 0;
  if (!name || page === 0 || extra.length > 0) return [notice('error', work.transcriptUsage)];
  const ordinal = workerOrdinal(name);
  const shown = shownWorkerAttempts.get(ledger);
  const workers = (await ledgerEntriesForWorkers(ledger, 'transcript')).filter((entry): entry is WorkLedgerWorkerEntry => entry.kind === 'worker');
  const numbering = shown ?? shownWorkerAttempts.get(ledger);
  const key = ordinal === undefined ? undefined : numbering?.attempts.get(ordinal);
  if (key === null) return [notice('error', fillTemplate(work.transcriptNoAttempt, { ref: name }))];
  const target = key !== undefined ? workers.find(worker => worker.attempt && attemptKey(worker.attempt) === key)
    : ordinal !== undefined && numbering?.listed ? null : resolveWorkerRef(name, workers);
  if (!target) return [notice('error', fillTemplate(work.transcriptNotFound, { ref: name }))];
  if (!target.attempt) return [notice('error', fillTemplate(work.transcriptNoAttempt, { ref: name }))];
  const text = await ledger.inspectTranscript!(target.attempt);
  // The list or another transcript can finish while the transcript port is reading.
  const pageRef = ordinal === undefined ? name : presentWorkerRef(ledger, target.attempt, ordinal, workers);
  const result = work.transcriptPage ? transcriptPage(text, page, pageRef, work.transcriptPage) : { ok: true as const, text };
  if (!result.ok) return [notice('error', result.text)];
  const headerRef = ordinal === undefined ? presentWorkerRef(ledger, target.attempt, target.ordinal) : pageRef;
  const header = [fillTemplate(work.transcriptHeader, { n: headerRef, attempt: shortId(target.attempt.attemptId), task: shortId(target.taskId) }),
    ...(work.transcriptDetail ? [fillTemplate(work.transcriptDetail, { attempt: target.attempt.attemptId, task: target.taskId })] : [])].join('\n');
  return [notice('info', `${header}\n${result.text}`)];
}

export async function runLedgerCommand(command: 'workers' | 'run' | 'runs' | 'transcript', args: string, ledger: WorklineLedgerPorts,
  labels: WorklineActionLabels): Promise<readonly WorkLedgerEntry[]> {
  if (command === 'transcript') return labels.work ? runTranscript(args.trim(), ledger, labels.work) : [notice('error', labels.ledgerUnavailable)];
  if (command === 'runs') {
    const cards = await ledgerEntriesForRuns(ledger, 'runs');
    return cards.length ? cards : [notice('info', labels.runsEmpty)];
  }
  if (command === 'workers') {
    const cards = await ledgerEntriesForWorkers(ledger, 'workers');
    showWorkerNumbering(ledger, cards);
    return cards.length ? cards : [notice('info', labels.workersEmpty)];
  }
  const runId = args.trim();
  if (!runId) return [notice('error', labels.runUsage)];
  const card = await ledgerEntryForRun(ledger, runId, 'run');
  return [card ?? notice('error', labels.runNotFound)];
}
