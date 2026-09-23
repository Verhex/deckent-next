import type { RunView, WorkerObservation, WorkerObservationReport, WorkerSidecars } from '#engine/index.js';

export const WORK_LEDGER_SCHEMA_VERSION = 1;

/** Deterministic phase from the worker event contract (`workerActivityPhase`); never a surface interpretation. */
export type WorkerLivePhase = NonNullable<WorkerSidecars['activity']>['phase'];
export type WorkerAttemptIdentity = NonNullable<WorkerObservation['identity']>;

/**
 * What the worker reported about itself (untrusted evidence, never acceptance or terminal truth). `receivedAt` is the
 * host clock; the worker-relative `atMs` is deliberately not carried so it can never be shown as wall time.
 */
export type WorkerLiveActivity = Readonly<{
  readonly phase: WorkerLivePhase | null;
  readonly target: string | null;
  readonly detail: string | null;
  readonly receivedAt: number | null;
  /** Provider named by the worker's own session start; shown only when the host does not know the provider. */
  readonly provider: string | null;
  readonly model: string | null;
  readonly outcome: 'success' | 'error' | 'limit' | 'running' | null;
  readonly tokens: number | null;
  readonly cacheReadRatio: number | null;
  readonly dropped: number;
  readonly unmapped: number;
  readonly eventsTruncated: boolean;
}>;

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
  /** 1-based position in the observation report; `/transcript <n>` resolves against the same numbering. */
  readonly ordinal?: number;
  readonly attempt?: WorkerAttemptIdentity | null;
  readonly live?: WorkerLiveActivity | null;
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

function workerLive(files: WorkerSidecars | null): WorkerLiveActivity | null {
  if (!files || (!files.activity && !files.usage && !files.eventsTruncated)) return null;
  const { activity, usage } = files;
  const tokens = usage ? usage.tokens.input + usage.tokens.output + usage.tokens.cacheRead + usage.tokens.cacheWrite : null;
  return Object.freeze({
    phase: activity?.phase ?? null, target: activity?.target ?? null, detail: activity?.detail ?? null, receivedAt: activity?.receivedAt ?? null,
    provider: usage?.provider ?? null, model: usage?.model ?? null, outcome: usage?.outcome ?? null, tokens, cacheReadRatio: usage?.cacheReadRatio ?? null,
    dropped: usage?.dropped ?? 0, unmapped: usage?.unmapped ?? 0, eventsTruncated: files.eventsTruncated,
  });
}

export function workerToLedgerEntry(scopeId: string, worker: WorkerObservation, entryId: string,
  context: { readonly ordinal?: number; readonly observedAtMs?: number } = {}): WorkLedgerWorkerEntry {
  const live = workerLive(worker.files);
  return Object.freeze({
    schemaVersion: WORK_LEDGER_SCHEMA_VERSION,
    kind: 'worker',
    id: entryId,
    scopeId,
    taskId: worker.taskId,
    process: worker.process,
    provider: worker.provider,
    authority: worker.authority,
    ...(context.observedAtMs === undefined ? {} : { observedAtMs: context.observedAtMs }),
    ...(context.ordinal === undefined ? {} : { ordinal: context.ordinal }),
    ...(worker.identity === undefined ? {} : { attempt: worker.identity }),
    ...(live ? { live } : {}),
  });
}

export function workerReportToLedgerEntries(report: WorkerObservationReport, idPrefix: string): WorkLedgerWorkerEntry[] {
  const entries: WorkLedgerWorkerEntry[] = [];
  let index = 0;
  for (const source of report.sources) {
    for (const worker of source.workers) {
      const ordinal = index + 1;
      entries.push(workerToLedgerEntry(report.scopeId, worker, `${idPrefix}-w-${index++}`,
        { ordinal, ...(Number.isSafeInteger(report.observedAt) ? { observedAtMs: report.observedAt } : {}) }));
    }
  }
  return entries;
}

export function ledgerEntrySummary(entry: WorkLedgerEntry): string {
  if (entry.kind === 'chat') return `${entry.role}: ${entry.text.slice(0, 80)}`;
  if (entry.kind === 'run') return `run ${entry.runId} rev ${entry.revision} ${entry.taskPhases}`;
  if (entry.kind === 'worker') {
    const phase = entry.live?.phase ? ` ${[entry.live.phase, entry.live.target].filter(Boolean).join(' ')}` : '';
    return `worker ${entry.taskId} ${entry.process}${phase}`;
  }
  return entry.text.slice(0, 80);
}
