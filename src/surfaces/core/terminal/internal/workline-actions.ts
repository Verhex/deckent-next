import type { WorkLedgerEntry } from './work-ledger.js';
import { WORK_LEDGER_SCHEMA_VERSION } from './work-ledger.js';
import { WORKLINE_SLASH_COMMANDS } from './slash-registry.js';
import type { WorklineLedgerPorts } from './workline-ledger.js';
import { ledgerEntriesForRuns, ledgerEntriesForWorkers, ledgerEntryForRun } from './workline-ledger.js';

export interface WorklineActionLabels {
  readonly ledgerUnavailable: string;
  readonly runNotFound: string;
  readonly workersEmpty: string;
  readonly runsEmpty: string;
  readonly runUsage: string;
  readonly watchStarted: string;
  readonly watchRunsStarted: string;
  readonly watchStopped: string;
  readonly statusLine: string;
  readonly unknownCommand: string;
}

export type WatchState = Readonly<{ workers: boolean; runs: boolean }>;

export interface WorklineActionContext {
  readonly ledger: WorklineLedgerPorts | undefined;
  readonly labels: WorklineActionLabels;
  readonly watch: WatchState;
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
  return { entries: [notice('error', `${labels.unknownCommand}: /${command}`)] };
}

export async function runLedgerCommand(command: 'workers' | 'run' | 'runs', args: string, ledger: WorklineLedgerPorts,
  labels: WorklineActionLabels): Promise<readonly WorkLedgerEntry[]> {
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
