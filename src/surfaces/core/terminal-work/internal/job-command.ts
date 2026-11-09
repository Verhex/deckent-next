import type { MutableRefObject } from 'react';
import type { WorklineLedgerPorts, WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { fillTemplate } from '#surfaces/core/terminal-ledger/index.js';
import { type SurfaceDeliveryMode } from '#surfaces/core/terminal-kit/index.js';
import type { LocalExecution, WorklinePanel } from './workline-panel.js';
import { immediateSlashAction, type WorklineActionLabels, type WatchState } from './workline-actions.js';
import type { LiveWindowKind } from './live-windows.js';
import { runJobWindow } from './job-windows.js';
import { systemSummaryEntry } from './system-summary.js';

interface WorkCommandContext {
  readonly execution: LocalExecution; readonly panel: WorklinePanel; readonly labels: WorklineActionLabels; readonly ledger: WorklineLedgerPorts | undefined;
  readonly push: (entries: readonly WorkLedgerEntry[]) => void; readonly errorText: (error: unknown) => string; readonly pushMode: SurfaceDeliveryMode;
  readonly watchRef: MutableRefObject<WatchState>; readonly setWatch: (state: WatchState) => void; readonly setWatchStatus: (text: string) => void;
  readonly monitor?: ((args: string) => Promise<readonly string[]>) | undefined;
  readonly live: { readonly canOpenMonitor: boolean; readonly openMonitor: () => Promise<void>; readonly show: (kind: Exclude<LiveWindowKind, 'monitor'>) => void };
  readonly runDecision: (command: 'approvals' | 'cancel' | 'runs', args: string, execution: LocalExecution) => Promise<void>;
  /** `{part}`: a slash command without its port in this terminal (`terminal.admin.partUnavailable`, the session language). */
  readonly commandUnavailable?: string | undefined;
  /** The person opened a Run window (`/run`, its id) or the Run list (`/runs`, no id): the active-work strip drops those finished Runs. */
  readonly onRunsSeen?: ((runId?: string) => void) | undefined;
}
/**
 * The job and approval windows (SW-2). SLASH-WINDOWS I-1 (owner 2026-10-08): a typed argument never selects anything here — the rich
 * workline strips it (and notes it once in the window), and a terminal without window words still opens the same window. Only `/monitor
 * <args>` without window words is left to the text command (returns false). Line/CLI producers keep their typed arguments.
 */
export async function dispatchWorkCommand(slash: { readonly command: string; readonly args: string }, context: WorkCommandContext): Promise<boolean> {
  if (slash.command === 'monitor') return monitorCommand(slash.args, context);
  const entry = Object.hasOwn(WORK_WINDOWS, slash.command) ? WORK_WINDOWS[slash.command] : undefined;
  return entry ? workWindow(slash.command, entry, context) : false;
}
async function monitorCommand(args: string, { execution, panel, labels, push, errorText, monitor, live, commandUnavailable }: WorkCommandContext): Promise<boolean> {
  if (args) return false;
  if (live.canOpenMonitor) await live.openMonitor();
  else {
    const title = labels.work?.live?.monitorTitle ?? '/monitor';
    let lines: readonly string[];
    const unwired = commandUnavailable ? fillTemplate(commandUnavailable, { part: 'monitor' }) : labels.work?.unavailable ?? labels.ledgerUnavailable;
    try { lines = monitor ? await monitor('') : [unwired]; }
    catch (error) { lines = [errorText(error)]; }
    await panel.pick(execution, { kind: 'window', title, body: lines, hints: labels.work?.jobs?.hints ?? '', confirm: false }, ['close']);
    push([systemSummaryEntry(labels.work?.live?.closedMonitor ?? title)]);
  }
  return true;
}
/** Per window command: the ledger ports it needs and how it opens (`decision` card, live `tasks` feed, read-only `window`); `/runs` is a card only with the lifecycle port and words (Y1). */
const WORK_WINDOWS: Readonly<Record<string, Readonly<{ wired: (ledger: WorklineLedgerPorts) => boolean; opens: 'decision' | 'tasks' | 'window' }> | undefined>> = Object.freeze({
  workers: { wired: () => true, opens: 'window' }, tasks: { wired: () => true, opens: 'tasks' }, transcript: { wired: ledger => Boolean(ledger.inspectTranscript), opens: 'window' },
  runs: { wired: ledger => Boolean(ledger.listRunIds), opens: 'window' }, run: { wired: ledger => Boolean(ledger.listRunIds), opens: 'window' },
  cancel: { wired: ledger => Boolean(ledger.listRunIds && ledger.cancelRun), opens: 'decision' }, approvals: { wired: ledger => Boolean(ledger.listApprovalPage && ledger.decideApproval), opens: 'decision' },
});
async function workWindow(command: string, entry: NonNullable<typeof WORK_WINDOWS[string]>, context: WorkCommandContext): Promise<boolean> {
  const { execution, panel, labels, ledger, push, errorText, pushMode, live, watchRef, setWatch, setWatchStatus, runDecision } = context;
  const workLabels = labels.work;
  try {
    if (!ledger || !workLabels?.jobs || !workLabels.live || !entry.wired(ledger)) {
      const text = workLabels?.unavailable ?? labels.ledgerUnavailable;
      await panel.pick(execution, { kind: 'window', title: `/${command}`, body: [text], hints: workLabels?.jobs?.hints ?? '', confirm: false }, ['close']);
      push([systemSummaryEntry(text)]); return true;
    }
    const opens = command === 'runs' && ledger.controlRun && workLabels.runControl ? 'decision' : entry.opens;
    if (opens === 'decision') {
      await runDecision(command as 'approvals' | 'cancel' | 'runs', '', execution);
      if (command === 'runs' && !execution.signal.aborted) context.onRunsSeen?.();
    } else if (opens === 'tasks') {
      const action = immediateSlashAction('tasks', { ledger, labels, watch: watchRef.current })!;
      if (action.watch) { watchRef.current = action.watch; setWatch(action.watch); }
      const feed = ledger.followEvents || ledger.followWorkers;
      // A refused or uninitialized feed delivers nothing, so the window names no delivery mode then (the refusal is its status line).
      const refused = pushMode === 'denied' || pushMode === 'not-initialized';
      setWatchStatus(refused ? '' : fillTemplate(workLabels.jobs.watchStatus, { mode: feed && pushMode !== 'poll' ? workLabels.jobs.push : workLabels.jobs.poll }));
      if (action.window) live.show(action.window);
    } else {
      const summary = await runJobWindow(command as 'workers' | 'runs' | 'run' | 'transcript', panel, execution, ledger, workLabels, context.onRunsSeen);
      if (!execution.signal.aborted) push([systemSummaryEntry(summary)]);
    }
  } catch (error) {
    await panel.pick(execution, { kind: 'window', title: `/${command}`, body: [errorText(error)], hints: workLabels?.jobs?.hints ?? '', confirm: false }, ['close']);
    if (!execution.signal.aborted) push([systemSummaryEntry(errorText(error))]);
  }
  return true;
}
