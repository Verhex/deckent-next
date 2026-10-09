import { ledgerEntriesForWorkers, loadRunViewsForWatch, type WorklineLedgerPorts, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import type { TaskWindowAction } from './live-windows.js';
import type { LocalExecution, WorklinePanel } from './workline-panel.js';
import type { WorkSurfaceLabels } from './workline-actions.js';

/** Selected identities travel out of band through the local controller; no typed slash argument can select or cancel a task. */
export async function openTaskAction(action: TaskWindowAction, panel: WorklinePanel, execution: LocalExecution, ledger: WorklineLedgerPorts,
  work: WorkSurfaceLabels, cancel: (runId: string) => Promise<void>): Promise<void> {
  if (execution.signal.aborted) return;
  if (action.target.scopeId !== ledger.scopeId) return;
  const runs = await loadRunViewsForWatch(ledger);
  const target = action.target;
  const run = target.kind === 'run' ? runs.find(run => run.runId === target.runId)
    : runs.find(run => (target.attempt ? run.runId === target.attempt.runId : run.tasks.some(task => task.id === target.taskId)));
  if (action.action === 'cancel') {
    if (run && ledger.cancelRun) await cancel(run.runId);
    else await panel.pick(execution, { kind: 'job-window', title: work.jobs!.cancelPickerTitle, lines: [{ spans: [span(work.unavailable)] }] }, ['close']);
    return;
  }
  let worker: WorkLedgerWorkerEntry | undefined;
  if (action.target.kind === 'worker') worker = action.target;
  else if (run) {
    const workers = (await ledgerEntriesForWorkers(ledger, 'tasks')).filter((entry): entry is WorkLedgerWorkerEntry => entry.kind === 'worker' && Boolean(entry.attempt)
      && entry.attempt?.runId === run.runId && run.tasks.some(task => task.id === entry.taskId));
    if (workers.length === 1) worker = workers[0];
    else if (workers.length > 1) {
      const picked = await panel.pick(execution, { kind: 'job-picker', title: work.jobs!.transcriptTitle,
        rows: workers.map(worker => [span(`${worker.ordinal ?? ''} · ${worker.live?.model ?? worker.provider}`)]) }, workers.map((_, index) => String(index)));
      if (picked !== null) worker = workers[Number(picked)];
    }
  }
  if (execution.signal.aborted) return;
  const text = worker?.attempt && ledger.inspectTranscript ? await ledger.inspectTranscript(worker.attempt) : work.unavailable;
  await panel.pick(execution, { kind: 'job-window', title: work.jobs!.transcriptTitle,
    lines: text.split(/\r?\n/u).map(line => ({ spans: [span(line)], exact: true })) }, ['close']);
}
