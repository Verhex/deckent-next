import { fillTemplate, ledgerEntriesForWorkers, loadRunViewsForWatch, type RunControlAction, type WorklineLedgerPorts, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import type { TaskWindowAction } from './live-windows.js';
import type { LocalExecution, WorklinePanel } from './workline-panel.js';
import type { WorkSurfaceLabels } from './workline-actions.js';
import { displayId, runDetailLines, runTitle } from './job-windows.js';

/** The work surface's card flows a Runs window row opens: each reads the Run again and asks with its own y/N card. */
export interface TaskActionCards {
  readonly cancel: (runId: string) => Promise<void>;
  readonly control: (runId: string, action: RunControlAction) => Promise<void>;
  /** K7 needs-input: the answer card of the Run's waiting task; absent: no answer port here. */
  readonly answer?: (runId: string) => Promise<void>;
  /** A read refusal's words (it stays inside the window it happened in). */
  readonly errorText: (error: unknown) => string;
}
/** Selected identities travel out of band through the local controller; no typed slash argument can select or cancel a task.
 * `deliver` is the workline's own (its delivery windows); every other row action lands here. */
export async function openTaskAction(action: TaskWindowAction, panel: WorklinePanel, execution: LocalExecution, ledger: WorklineLedgerPorts,
  work: WorkSurfaceLabels, cards: TaskActionCards): Promise<void> {
  if (execution.signal.aborted) return;
  if (action.target.scopeId !== ledger.scopeId) return;
  const runs = await loadRunViewsForWatch(ledger);
  const target = action.target;
  const run = target.kind === 'run' ? runs.find(run => run.runId === target.runId)
    : runs.find(run => (target.attempt ? run.runId === target.attempt.runId : run.tasks.some(task => task.id === target.taskId)));
  if (action.action === 'run') {
    // The same read model and window as `/run`: the Run is read again here, so the window never shows a stale strip copy.
    await panel.pick(execution, run ? { kind: 'job-window', title: runTitle(run, work.jobs!), lines: runDetailLines(run, work) }
      : { kind: 'job-window', title: work.jobs!.runTitle, lines: [{ spans: [span(work.unavailable)] }] }, ['close']);
    return;
  }
  if (action.action === 'hold' || action.action === 'resume' || action.action === 'close') {
    if (run && ledger.controlRun && work.runControl) await cards.control(run.runId, action.action);
    else await panel.pick(execution, { kind: 'job-window', title: work.jobs!.runTitle, lines: [{ spans: [span(work.unavailable)] }] }, ['close']);
    return;
  }
  if (action.action === 'answer') {
    if (run && cards.answer) await cards.answer(run.runId);
    else await panel.pick(execution, { kind: 'job-window', title: work.jobs!.runTitle, lines: [{ spans: [span(work.unavailable)] }] }, ['close']);
    return;
  }
  if (action.action === 'deliver') return;
  if (action.action === 'cancel') {
    if (run && ledger.cancelRun) await cards.cancel(run.runId);
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
  // The sealed transcript under its worker/attempt/task header; a refusal (read-output policy) stays inside the same window.
  let text = work.unavailable, failed = false;
  if (worker?.attempt && ledger.inspectTranscript) {
    try { text = await ledger.inspectTranscript(worker.attempt); } catch (error) { text = cards.errorText(error); failed = true; }
  }
  if (execution.signal.aborted) return;
  const header = worker?.attempt && !failed ? [{ spans: [span(fillTemplate(work.transcriptHeader, { n: worker.ordinal ?? 1, attempt: displayId(worker.attempt.attemptId), task: displayId(worker.taskId) }), { role: 'muted' as const })] }] : [];
  await panel.pick(execution, { kind: 'job-window', title: work.jobs!.transcriptTitle,
    lines: [...header, ...text.split(/\r?\n/u).map(line => ({ spans: [span(line, failed ? { role: 'error' as const } : {})], exact: true }))] }, ['close']);
}
