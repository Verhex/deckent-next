import type { RunView, WorkerObservationReport } from '#engine/index.js';
import type { WorkLedgerEntry } from './work-ledger.js';
import { runViewToLedgerEntry, workerReportToLedgerEntries } from './work-ledger.js';

export interface WorklineLedgerPorts {
  readonly scopeId: string;
  readonly listWorkers: () => Promise<WorkerObservationReport>;
  readonly inspectRun: (runId: string) => Promise<RunView | null>;
  readonly listRunIds?: () => Promise<readonly string[]>;
  readonly workerHeartbeatMs?: number;
  /** When set, replaces polling for that watch. The runtime owns the event source. */
  readonly followWorkers?: (signal: AbortSignal) => AsyncIterable<readonly WorkLedgerEntry[]>;
  readonly followRuns?: (signal: AbortSignal) => AsyncIterable<readonly WorkLedgerEntry[]>;
}

export async function loadRunViewsForWatch(ports: WorklineLedgerPorts): Promise<RunView[]> {
  if (!ports.listRunIds) return [];
  const ids = await ports.listRunIds();
  const views: RunView[] = [];
  for (const runId of ids) {
    const view = await ports.inspectRun(runId);
    if (view) views.push(view);
  }
  return views;
}

export async function ledgerEntriesForWorkers(ports: WorklineLedgerPorts, idPrefix: string): Promise<WorkLedgerEntry[]> {
  const report = await ports.listWorkers();
  return workerReportToLedgerEntries(report, idPrefix);
}

export async function ledgerEntryForRun(ports: WorklineLedgerPorts, runId: string, idPrefix: string): Promise<WorkLedgerEntry | null> {
  const run = await ports.inspectRun(runId);
  if (!run) return null;
  return runViewToLedgerEntry(run, `${idPrefix}-run-${runId}`);
}
