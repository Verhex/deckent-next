import type { WorkLedgerEntry, WorkLedgerWorkerEntry } from './work-ledger.js';
import { WORK_LEDGER_SCHEMA_VERSION } from './work-ledger.js';
import { fillTemplate, type WorkerLineLabels } from './worker-line.js';
import type { WorkerPanelLabels } from './worker-panel.js';
import { WORKLINE_SLASH_COMMANDS } from '#surfaces/core/terminal-kit/index.js';
import type { WorklineLedgerPorts } from './workline-ledger.js';
import { ledgerEntriesForRuns, ledgerEntriesForWorkers, ledgerEntryForRun } from './workline-ledger.js';

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
  readonly statusLine: string;
  readonly unknownCommand: string;
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
  readonly ledger: WorklineLedgerPorts | undefined;
  readonly labels: WorklineActionLabels;
  readonly watch: WatchState;
  readonly canRestartService?: boolean;
}

/** Result of one slash command; the view applies it. Entries carry no identity: the ledger buffer assigns sequence ids. */
export type WorklineActionResult = Readonly<{ entries: readonly WorkLedgerEntry[]; watch?: WatchState; exit?: true }>;

export function notice(level: 'info' | 'error', text: string): WorkLedgerEntry {
  return Object.freeze({ schemaVersion: WORK_LEDGER_SCHEMA_VERSION, kind: 'notice' as const, id: 'notice', level, text });
}

function helpLine(): string {
  return [...new Set(WORKLINE_SLASH_COMMANDS.map(command => `/${command.name}`))].join(' · ');
}

/** Pure dispatch for immediate commands; `needsLedger` commands return null and run through `runLedgerCommand`. */
export function immediateSlashAction(command: string, context: WorklineActionContext): WorklineActionResult | null {
  const { labels, watch, ledger } = context;
  if (command === 'exit' || command === 'quit') return { entries: [], exit: true };
  if (command === 'help') return { entries: [notice('info', helpLine())] };
  if (command === 'status' || command === 'chat-backend') return { entries: [notice('info', labels.statusLine)] };
  if (command === 'watch-workers') {
    if (!ledger) return { entries: [notice('error', labels.ledgerUnavailable)] };
    return watch.workers ? { entries: [] } : { entries: [notice('info', labels.watchStarted)], watch: { ...watch, workers: true } };
  }
  if (command === 'watch-runs') {
    if (!ledger?.listRunIds) return { entries: [notice('error', labels.ledgerUnavailable)] };
    return watch.runs ? { entries: [] } : { entries: [notice('info', labels.watchRunsStarted)], watch: { ...watch, runs: true } };
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
