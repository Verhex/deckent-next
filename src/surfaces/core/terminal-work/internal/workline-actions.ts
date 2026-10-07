import { type WorkLedgerEntry, type WorkLedgerWorkerEntry, notice, fillTemplate, type WorkerLineLabels, type WorklineLedgerPorts, ledgerEntriesForRuns, ledgerEntriesForWorkers, ledgerEntryForRun } from '#surfaces/core/terminal-ledger/index.js';
import type { WorkerPanelLabels } from './worker-panel.js';
import type { ApprovalWindowLabels } from './approval-window.js';
import { slashHelpText, surfaceDeliveryValues, WORKLINE_SLASH_COMMANDS, type SurfaceDeliveryMode } from '#surfaces/core/terminal-kit/index.js';

export interface WorklineActionLabels {
  readonly ledgerUnavailable: string;
  readonly runNotFound: string;
  readonly workersEmpty: string;
  readonly runsEmpty: string;
  readonly serviceRestartUnavailable: string;
  readonly queued: string;
  readonly runUsage: string;
  readonly watchStarted: string;
  readonly watchRunsStarted: string;
  readonly watchStopped: string;
  /** `{mode}` is `push` or `poll`. Present in production; tests omit it unless they assert the mark. */
  readonly watchDelivery?: string;
  /** `{status}` is `gap`, `backpressure` or `foreign-scope`. */
  readonly watchStep?: string;
  readonly watchPushFailed?: string;
  readonly watchNotInitialized?: string; readonly watchAccessDenied?: string;
  readonly watchAccessStopped?: string;
  readonly statusLine: string;
  readonly unknownCommand: string;
  /** The same registry-derived labels as the palette; optional for callers without a composer. */
  readonly composer?: { readonly slash: Readonly<Record<string, string>> };
  /** Worker live line, transcript, approvals and run control; absent means those commands are not offered. */
  readonly work?: WorkSurfaceLabels;
}

/** Catalog strings for the work surface (P4). Templates use `{name}` placeholders. */
export interface WorkSurfaceLabels {
  readonly workerLine: WorkerLineLabels;
  readonly panel: WorkerPanelLabels;
  readonly unavailable: string;
  readonly transcriptUsage: string;
  readonly transcriptNotFound: string;
  readonly transcriptNoAttempt: string;
  readonly transcriptHeader: string;
  readonly sessionStandingClear?: { readonly cleared: string; readonly unconfirmed: string };
  readonly approvalsNone: string;
  readonly approvalItem: string;
  readonly approvalsTruncated: string;
  readonly approvalNotFound: string;
  readonly approvalTitle: string;
  readonly approvalSubject: string;
  /** `{count}` more preview lines of a tool-call approval are not shown on the card. */
  readonly approvalPreviewMore: string;
  readonly approvalExpires: string;
  readonly approvalPrompt: string;
  readonly approvalPending: string;
  readonly approvalAllowed: string;
  readonly approvalDenied: string;
  /** `{id}`: the service could not confirm closing a tool-call approval request; the call did not run. */
  readonly approvalUnsettled: string;
  readonly approvalMore: string;
  readonly approvalNotify: string;
  readonly approvalPollFailed: string;
  /** Single card lines (B1): `risk` with `{risk}`/`{undo}`; nothing runs on expiry; assurance turn-bound here / elsewhere / peer-session / other `{level}`. */
  readonly approvalCard: { readonly risk: string; readonly notDeclared: string; readonly onExpiry: string; readonly assuranceTurnHere: string; readonly assuranceTurnElsewhere: string; readonly assurancePeer: string; readonly assuranceOther: string };
  /** Standing scopes on an approval card (PERSISTENT-APPROVALS G6); absent = the plain y/N card only. */
  readonly approvalStanding?: {
    /** `{pattern}`: exactly what a standing answer covers (the command, or the directory pattern). */
    readonly covers: string;
    readonly promptBoth: string;
    readonly promptSession: string;
    readonly promptAlways: string;
    /** `{id}`: the approval was allowed and the standing answer saved; `notSaved…` adds `{reason}` (the call was allowed once either way). */
    readonly savedSession: string;
    readonly savedAlways: string;
    readonly unconfirmedSession: string;
    readonly notSavedSession: string;
    readonly notSavedAlways: string;
  };
  /** Bounded windows (TS-WINDOW): `position` has `{from}`, `{to}`, `{total}`; `pick` is a list window's key hints; titles of the list
   * windows; the `/service-restart` confirmation (title, what happens, keys, kept). */
  readonly window: Readonly<{ position: string; pick: string; approvalsTitle: string; resumeTitle: string;
    restartTitle: string; restartDetail: string; restartPrompt: string; restartKept: string }>;
  /** The approval window's labelled fields (T-APPROVAL-WINDOW). */
  readonly approvalWindow: ApprovalWindowLabels;
  readonly cancelUsage: string;
  readonly cancelTitle: string;
  readonly cancelDetail: string;
  readonly cancelAlreadyRequested: string;
  readonly cancelPrompt: string;
  readonly cancelPending: string;
  readonly cancelKept: string;
}

/** Commands owned by the work surface; they need its labels and their port. */
export const WORK_SURFACE_COMMANDS = Object.freeze(['transcript', 'approvals', 'cancel'] as const);
export type WorkSurfaceCommand = typeof WORK_SURFACE_COMMANDS[number];
export function isWorkSurfaceCommand(command: string): command is WorkSurfaceCommand {
  return (WORK_SURFACE_COMMANDS as readonly string[]).includes(command);
}

export type WatchState = Readonly<{ workers: boolean; runs: boolean }>;

export interface WorklineActionContext {
  readonly followDelivery?: SurfaceDeliveryMode;
  readonly ledger: WorklineLedgerPorts | undefined;
  readonly labels: WorklineActionLabels;
  readonly watch: WatchState;
  readonly canRestartService?: boolean;
  /** Poll interval used when the watch has no push port. The delivery line reports this timeout. */
  readonly pollMs?: number;
}

/** Result of one slash command; the view applies it. Entries carry no identity: the ledger buffer assigns sequence ids. */
export type WorklineActionResult = Readonly<{ entries: readonly WorkLedgerEntry[]; watch?: WatchState; exit?: true }>;

/** Pure dispatch for immediate commands; `needsLedger` commands return null and run through `runLedgerCommand`. */
export function immediateSlashAction(command: string, context: WorklineActionContext): WorklineActionResult | null {
  const { labels, watch, ledger } = context;
  if (command === 'exit' || command === 'quit') return { entries: [], exit: true };
  if (command === 'help') return { entries: [notice('info', slashHelpText(labels.composer?.slash ?? {}, WORKLINE_SLASH_COMMANDS))] };
  if (command === 'status' || command === 'chat-backend') return { entries: [notice('info', labels.statusLine)] };
  if (command === 'watch-workers' || command === 'watch-runs') {
    const runs = command === 'watch-runs';
    if (!ledger || (runs && !ledger.listRunIds)) return { entries: [notice('error', labels.ledgerUnavailable)] };
    if (runs ? watch.runs : watch.workers) return { entries: [] };
    const mode = context.followDelivery ?? (ledger.followEvents || (runs ? ledger.followRuns : ledger.followWorkers) ? 'push' as const : 'poll' as const);
    const pace = context.pollMs ?? ledger.workerHeartbeatMs;
    const delivery = labels.watchDelivery && pace !== undefined ? [notice('info', fillTemplate(labels.watchDelivery, surfaceDeliveryValues(mode, pace)))] : [];
    return { entries: [notice('info', runs ? labels.watchRunsStarted : labels.watchStarted), ...delivery], watch: { ...watch, [runs ? 'runs' : 'workers']: true } };
  }
  if (command === 'watch-stop') {
    return watch.workers || watch.runs ? { entries: [notice('info', labels.watchStopped)], watch: { workers: false, runs: false } } : { entries: [] };
  }
  if (command === 'runs') {
    if (!ledger?.listRunIds) return { entries: [notice('error', labels.ledgerUnavailable)] };
    return null;
  }
  if (command === 'workers' || command === 'run') return ledger ? null : { entries: [notice('error', labels.ledgerUnavailable)] };
  if (command === 'service-restart') return context.canRestartService ? null : { entries: [notice('error', labels.serviceRestartUnavailable)] };
  if (isWorkSurfaceCommand(command)) {
    const wired = command === 'transcript' ? ledger?.inspectTranscript : command === 'approvals' ? ledger?.listApprovalPage && ledger.decideApproval : ledger?.cancelRun;
    return labels.work && wired ? null : { entries: [notice('error', labels.work?.unavailable ?? labels.ledgerUnavailable)] };
  }
  return { entries: [notice('error', `${labels.unknownCommand}: /${command}`)] };
}

/** `n` is the worker number shown by `/workers` and the live panel; anything else is an attempt id. */
export function resolveWorkerRef(ref: string, workers: readonly WorkLedgerWorkerEntry[]): WorkLedgerWorkerEntry | null {
  if (/^[1-9][0-9]*$/.test(ref)) return workers.find(worker => worker.ordinal === Number(ref)) ?? null;
  return workers.find(worker => worker.attempt?.attemptId === ref) ?? null;
}

/** Read-only: resolves the worker on a fresh observation and shows its sealed transcript; never prompts. */
async function runTranscript(ref: string, ledger: WorklineLedgerPorts, work: WorkSurfaceLabels): Promise<readonly WorkLedgerEntry[]> {
  if (!ref || /\s/.test(ref)) return [notice('error', work.transcriptUsage)];
  const workers = (await ledgerEntriesForWorkers(ledger, 'transcript')).filter((entry): entry is WorkLedgerWorkerEntry => entry.kind === 'worker');
  const target = resolveWorkerRef(ref, workers);
  if (!target) return [notice('error', fillTemplate(work.transcriptNotFound, { ref }))];
  if (!target.attempt) return [notice('error', fillTemplate(work.transcriptNoAttempt, { ref }))];
  const text = await ledger.inspectTranscript!(target.attempt);
  const header = fillTemplate(work.transcriptHeader, { n: target.ordinal ?? ref, attempt: target.attempt.attemptId, task: target.taskId });
  return [notice('info', `${header}\n${text}`)];
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
    return cards.length ? cards : [notice('info', labels.workersEmpty)];
  }
  const runId = args.trim();
  if (!runId) return [notice('error', labels.runUsage)];
  const card = await ledgerEntryForRun(ledger, runId, 'run');
  return [card ?? notice('error', labels.runNotFound)];
}
