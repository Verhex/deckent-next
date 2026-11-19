import type { ObservedRun } from '#surfaces/core/recovery-text/index.js';
import type { RunProgressionDiagnostic } from '#engine/index.js';
const diagnosticKey = (value: RunProgressionDiagnostic | undefined) => value ? JSON.stringify([value.state, value.reason, value.policyRevision, value.session, value.suspended, value.parkUnavailable, value.missing]) : '';
import type { WorkLedgerRunEntry } from './work-ledger.js';
import { runViewToLedgerEntry } from './work-ledger.js';
import { WATCH_SEEN_LIMIT } from './worker-watch.js';

export function runWatchFingerprint(run: ObservedRun): string {
  const phases = new Map<string, number>();
  for (const task of run.tasks) phases.set(task.phase, (phases.get(task.phase) ?? 0) + 1);
  const phaseKey = [...phases.entries()].map(([phase, count]) => `${phase}:${count}`).join(' ');
  return `${run.revision}|${run.cancellationRequested}|${phaseKey}|${diagnosticKey(run.progression)}`;
}

export function newRunLedgerEntries(
  seen: ReadonlyMap<string, string>,
  runs: readonly ObservedRun[],
  idPrefix: string,
): { readonly seen: Map<string, string>; readonly fresh: readonly WorkLedgerRunEntry[] } {
  const next = new Map(seen);
  const fresh: WorkLedgerRunEntry[] = [];
  let index = 0;
  for (const run of runs) {
    const fingerprint = runWatchFingerprint(run);
    if (next.get(run.runId) === fingerprint) continue;
    next.delete(run.runId);
    next.set(run.runId, fingerprint);
    fresh.push(runViewToLedgerEntry(run, `${idPrefix}-run-${run.runId}-${index++}`));
  }
  for (const key of next.keys()) { if (next.size <= WATCH_SEEN_LIMIT) break; next.delete(key); }
  return { seen: next, fresh: Object.freeze(fresh) };
}

/** Identity for pushed run cards: revision, cancellation and phase summary. */
export function freshRunCards(
  seen: ReadonlyMap<string, string>,
  cards: readonly WorkLedgerRunEntry[],
): { readonly seen: Map<string, string>; readonly fresh: readonly WorkLedgerRunEntry[] } {
  const next = new Map(seen);
  const fresh: WorkLedgerRunEntry[] = [];
  for (const card of cards) {
    const fingerprint = `${card.revision}|${card.cancellationRequested}|${card.taskPhases}|${diagnosticKey(card.progression)}`;
    if (next.get(card.runId) === fingerprint) continue;
    next.delete(card.runId);
    next.set(card.runId, fingerprint);
    fresh.push(card);
  }
  for (const key of next.keys()) { if (next.size <= WATCH_SEEN_LIMIT) break; next.delete(key); }
  return { seen: next, fresh: Object.freeze(fresh) };
}
