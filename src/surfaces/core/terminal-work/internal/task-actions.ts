import { resolveLocale, t } from '#platform/index.js';
import { ledgerEntriesForWorkers, loadRunViewsForWatch, type WorklineLedgerPorts, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import type { TaskWindowAction } from './live-windows.js';
import type { LocalExecution, WorklinePanel } from './workline-panel.js';
import type { WorkSurfaceLabels } from './workline-actions.js';
import { workerApprovalWaitLines, queueRowSummaries, runDetailLines, runTitle } from './job-windows.js';

/** The configured observer reserves `current` for the same root as the action ports. */
const localWorker = (worker: WorkLedgerWorkerEntry) => worker.sourceId === undefined || worker.sourceId === 'current';

/** Selected identities travel out of band through the local controller; no typed slash argument can select or cancel a task. */
export async function openTaskAction(action: TaskWindowAction, panel: WorklinePanel, execution: LocalExecution, ledger: WorklineLedgerPorts,
  work: WorkSurfaceLabels, cancel: (runId: string) => Promise<void>): Promise<string | void> {
  if (execution.signal.aborted) return;
  if (action.target.scopeId !== ledger.scopeId) return;
  const target = action.target;
  const runId = target.kind === 'run' ? target.runId : target.attempt?.runId;
  const otherProject = target.kind === 'worker' && target.attempt && !localWorker(target);
  const locale = resolveLocale(work.jobs?.locale ?? work.workerLine.numberLocale);
  if (action.action === 'cancel' && (runId === undefined || otherProject)) return t('terminal.live.workerCancelUnavailable', {}, locale);
  if (action.action === 'transcript' && otherProject) return t('terminal.live.workerTranscriptUnavailable', {}, locale);
  const runs = await loadRunViewsForWatch(ledger);
  const run = runs.find(run => run.scopeId === target.scopeId && run.runId === runId);
  if (action.action === 'run') {
    // The same read model and window as `/run`: the Run is read again here, so the window never shows a stale strip copy.
    await panel.pick(execution, run ? { kind: 'job-window', title: runTitle(run, work.jobs!), lines: [...runDetailLines(run, work, await queueRowSummaries(run, ledger.queueSummaryLines)), ...await workerApprovalWaitLines(ledger, run.runId, work)] }
      : { kind: 'job-window', title: work.jobs!.runTitle, lines: [{ spans: [span(work.unavailable)] }] }, ['close']);
    return;
  }
  if (action.action === 'cancel') {
    if (run && ledger.cancelRun) await cancel(run.runId);
    else await panel.pick(execution, { kind: 'job-window', title: work.jobs!.cancelPickerTitle, lines: [{ spans: [span(work.unavailable)] }] }, ['close']);
    return;
  }
  let worker: WorkLedgerWorkerEntry | undefined;
  let unavailable = work.unavailable;
  if (action.target.kind === 'worker') worker = action.target;
  else if (run) {
    const workers = (await ledgerEntriesForWorkers(ledger, 'tasks')).filter((entry): entry is WorkLedgerWorkerEntry => entry.kind === 'worker' && Boolean(entry.attempt) && localWorker(entry)
      && entry.attempt?.runId === run.runId && run.tasks.some(task => task.id === entry.taskId));
    if (workers.length === 0 && ledger.inspectTranscript) unavailable = t('terminal.live.runTranscriptNoLocalWorker', {}, locale);
    else if (workers.length === 1) worker = workers[0];
    else if (workers.length > 1) {
      const picked = await panel.pick(execution, { kind: 'job-picker', title: work.jobs!.transcriptTitle,
        rows: workers.map(worker => [span(`${worker.ordinal ?? ''} · ${worker.live?.model ?? worker.provider}`)]) }, workers.map((_, index) => String(index)));
      if (picked !== null) worker = workers[Number(picked)];
    }
  }
  if (execution.signal.aborted) return;
  const text = worker?.attempt && ledger.inspectTranscript ? await ledger.inspectTranscript(worker.attempt) : unavailable;
  await panel.pick(execution, { kind: 'job-window', title: work.jobs!.transcriptTitle,
    lines: text.split(/\r?\n/u).map(line => ({ spans: [span(line)], exact: true })) }, ['close']);
}
