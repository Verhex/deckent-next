import type { RunView, WorkerObservation, WorkerObservationReport } from '#engine/index.js';

export const WORK_LEDGER_SCHEMA_VERSION = 1;

export type WorkLedgerChatEntry = Readonly<{
  readonly schemaVersion: typeof WORK_LEDGER_SCHEMA_VERSION;
  readonly kind: 'chat';
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}>;

export type WorkLedgerRunEntry = Readonly<{
  readonly schemaVersion: typeof WORK_LEDGER_SCHEMA_VERSION;
  readonly kind: 'run';
  readonly id: string;
  readonly runId: string;
  readonly scopeId: string;
  readonly revision: number;
  readonly cancellationRequested: boolean;
  readonly taskPhases: string;
  readonly observedAtMs?: number;
}>;

export type WorkLedgerWorkerEntry = Readonly<{
  readonly schemaVersion: typeof WORK_LEDGER_SCHEMA_VERSION;
  readonly kind: 'worker';
  readonly id: string;
  readonly scopeId: string;
  readonly taskId: string;
  readonly process: string;
  readonly provider: string;
  readonly authority: string;
  readonly observedAtMs?: number;
}>;

export type WorkLedgerNoticeEntry = Readonly<{
  readonly schemaVersion: typeof WORK_LEDGER_SCHEMA_VERSION;
  readonly kind: 'notice';
  readonly id: string;
  readonly level: 'info' | 'error';
  readonly text: string;
}>;

export type WorkLedgerEntry = WorkLedgerChatEntry | WorkLedgerRunEntry | WorkLedgerWorkerEntry | WorkLedgerNoticeEntry;

function phaseSummary(run: RunView): string {
  const counts = new Map<string, number>();
  for (const task of run.tasks) counts.set(task.phase, (counts.get(task.phase) ?? 0) + 1);
  return [...counts.entries()].map(([phase, count]) => `${phase}:${count}`).join(' ') || '—';
}

export function runViewToLedgerEntry(run: RunView, entryId: string): WorkLedgerRunEntry {
  return Object.freeze({
    schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
    kind: 'run',
    id: entryId,
    runId: run.runId,
    scopeId: run.scopeId,
    revision: run.revision,
    cancellationRequested: run.cancellationRequested,
    taskPhases: phaseSummary(run),
  });
}

export function workerToLedgerEntry(scopeId: string, worker: WorkerObservation, entryId: string): WorkLedgerWorkerEntry {
  return Object.freeze({
    schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
    kind: 'worker',
    id: entryId,
    scopeId,
    taskId: worker.taskId,
    process: worker.process,
    provider: worker.provider,
    authority: worker.authority,
  });
}

export function workerReportToLedgerEntries(report: WorkerObservationReport, idPrefix: string): WorkLedgerWorkerEntry[] {
  const entries: WorkLedgerWorkerEntry[] = [];
  let index = 0;
  for (const source of report.sources) {
    for (const worker of source.workers) {
      entries.push(workerToLedgerEntry(report.scopeId, worker, `${idPrefix}-w-${index++}`));
    }
  }
  return entries;
}

export function ledgerEntrySummary(entry: WorkLedgerEntry): string {
  if (entry.kind === 'chat') return `${entry.role}: ${entry.text.slice(0, 80)}`;
  if (entry.kind === 'run') return `run ${entry.runId} rev ${entry.revision} ${entry.taskPhases}`;
  if (entry.kind === 'worker') return `worker ${entry.taskId} ${entry.process}`;
  return entry.text.slice(0, 80);
}
