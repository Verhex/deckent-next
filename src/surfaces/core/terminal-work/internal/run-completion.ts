import { useCallback, useRef, useState } from 'react';
import type { RunView } from '#engine/index.js';
import { fillTemplate, type WorkLedgerEntry, type WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { useSingleFlightPoll } from '#surfaces/core/terminal-kit/index.js';
import { runStateText, type JobWindowLabels } from './job-windows.js';
import { systemSummaryEntry } from './system-summary.js';

/** Counts use canonical task phases; unavailable output never implies zero delivery work. */
export function runCompletionText(run: RunView, labels: JobWindowLabels): string {
  const counts = { accepted: 0, rejected: 0, failed: 0, cancelled: 0, none: 0, patch: 0, awaiting: 0, unknown: 0 };
  for (const task of run.tasks) {
    if (task.phase === 'accepted') counts.accepted++;
    if (task.phase === 'failed') counts.failed++;
    if (task.phase === 'cancelled') counts.cancelled++;
    if (task.resultBrief?.evaluation.verdict === 'rejected') counts.rejected++;
    const outlook = task.resultBrief?.deliveryOutlook;
    if (outlook === 'none') counts.none++;
    else if (outlook === 'patch-not-prepared') counts.patch++;
    else if (outlook === 'awaiting-delivery') counts.awaiting++;
    else counts.unknown++;
  }
  const details = run.tasks.some(task => !task.resultBrief);
  return [fillTemplate(labels.completed, { run: run.runId, state: runStateText(run, labels), ...counts, rejected: details ? labels.unknown : counts.rejected }),
    ...(counts.patch + counts.awaiting > 0 ? [fillTemplate(labels.deliveryCounts, { ...counts, patch: counts.patch > 0 ? fillTemplate(labels.deliveryPatch, { patch: counts.patch }) : '' })] : counts.unknown > 0 ? [fillTemplate(labels.deliveryCounts, { ...counts, none: labels.unknown, patch: '', awaiting: labels.unknown })] : []),
    ...(counts.patch + counts.awaiting > 0 ? [fillTemplate(labels.deliveryNext, { run: run.runId })] : [])].join('\n');
}

/** Session-only ownership: admission registers identity/state, snapshots supply authorized result data. */
export function useRunCompletion(input: { readonly limit: number | undefined; readonly labels: JobWindowLabels | undefined;
  readonly ledger: WorklineLedgerPorts | undefined; readonly pollMs: number; readonly refused: boolean;
  readonly push: (entries: readonly WorkLedgerEntry[]) => void; readonly errorText: (error: unknown) => string }) {
  const records = useRef(new Map<string, { revision: number; terminal: boolean; notified: boolean }>());
  const [generation, advance] = useState(0);
  const [pending, setPending] = useState(false);
  const [denied, setDenied] = useState(false);
  const observe = useCallback((runs: readonly RunView[]) => {
    for (const run of runs) {
      const record = records.current.get(run.runId);
      if (!record || run.scopeId !== input.ledger?.scopeId || run.revision < record.revision) continue;
      const terminal = run.state.kind === 'terminal';
      if (terminal && !record.terminal && !record.notified && input.labels) {
        record.notified = true;
        input.push([systemSummaryEntry(runCompletionText(run, input.labels)),
          ...(run.tasks.some(task => !task.resultBrief) ? [systemSummaryEntry(input.labels.detailsUnavailable, 'warning')] : [])]);
      }
      record.revision = run.revision; record.terminal = terminal;
    }
    setPending([...records.current.values()].some(record => !record.notified));
  }, [input.labels, input.ledger?.scopeId, input.push]);
  const register = useCallback((run: RunView) => {
    if (!input.labels || !input.limit || run.scopeId !== input.ledger?.scopeId || records.current.has(run.runId)) return;
    if (records.current.size >= input.limit) {
      const finished = [...records.current].find(([, record]) => record.notified);
      if (finished) records.current.delete(finished[0]);
      else {
        input.push([systemSummaryEntry(fillTemplate(input.labels.trackingFull, { run: run.runId, limit: input.limit }), 'warning')]);
        return;
      }
    }
    // An admission may race with completion; first authorized inspection still announces it once.
    records.current.set(run.runId, { revision: run.revision, terminal: false, notified: false });
    setPending(true); advance(value => value + 1);
  }, [input.labels, input.limit, input.ledger?.scopeId, input.push]);
  // Production uses serialized push snapshots. Older/test ports without that seam inspect only admitted identities.
  useSingleFlightPoll(pending && !input.refused && !denied && Boolean(input.ledger) && !(input.ledger?.followEvents && input.ledger.readSurfaceSnapshot), input.pollMs,
    async current => {
      for (const [runId, record] of records.current) {
        if (!current() || record.notified) continue;
        const run = await input.ledger!.inspectRun(runId);
        if (current() && run) observe([run]);
      }
    }, error => {
      if (['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED', 'SCOPE_UNKNOWN', 'APPROVAL_DENIED'].includes(String((error as { code?: unknown })?.code))) setDenied(true);
      input.push([systemSummaryEntry(input.errorText(error), 'error')]);
    });
  return { register, observe, generation };
}
