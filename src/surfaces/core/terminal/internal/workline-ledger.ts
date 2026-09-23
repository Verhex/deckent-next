import type { RunView, WorkerObservationReport } from '#engine/index.js';
import type { WorkerAttemptIdentity, WorkLedgerEntry } from './work-ledger.js';
import type { ListApprovalPage, WorklineApproval } from './approval-watch.js';
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
  /** Sealed worker transcript of one attempt, rendered by the CLI renderer (attempt `read-output` policy applies). */
  readonly inspectTranscript?: (attempt: WorkerAttemptIdentity) => Promise<string>;
  /** One page of the scope's approval records through the runtime approval application. */
  readonly listApprovalPage?: ListApprovalPage;
  /** Records one explicit operator decision through the runtime (same live-session path as `approvals decide`). */
  readonly decideApproval?: (approval: Pick<WorklineApproval, 'approvalId' | 'revision'>, decision: 'allow' | 'deny') => Promise<WorklineApproval>;
  /** Governed run cancellation (`run cancel`) against the inspected revision; returns the rendered typed outcome. */
  readonly cancelRun?: (runId: string, expectedRevision: number) => Promise<string>;
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

export async function ledgerEntriesForRuns(ports: WorklineLedgerPorts, idPrefix: string): Promise<WorkLedgerEntry[]> {
  const views = await loadRunViewsForWatch(ports);
  return views.map(run => runViewToLedgerEntry(run, `${idPrefix}-run-${run.runId}`));
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
