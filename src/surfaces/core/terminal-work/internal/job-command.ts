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
  readonly live: { readonly canOpenMonitor: boolean; readonly openMonitor: () => Promise<void>; readonly close: () => void; readonly show: (kind: Exclude<LiveWindowKind, 'monitor'> | null) => void };
  readonly runDecision: (command: 'approvals' | 'cancel', args: string, execution: LocalExecution) => Promise<void>;
  /** `{part}`: a slash command without its port in this terminal (`terminal.admin.partUnavailable`, the session language). */
  readonly commandUnavailable?: string | undefined;
}
/**
 * The job and approval windows (SW-2). SLASH-WINDOWS I-1 (owner 2026-10-08): a typed argument never selects anything here — the rich
 * workline strips it (and notes it once in the window), and a terminal without window words still opens the same window. Only `/monitor
 * <args>` without window words is left to the text command (returns false). Line/CLI producers keep their typed arguments.
 */
export async function dispatchWorkCommand(slash: { readonly command: string; readonly args: string }, context: WorkCommandContext): Promise<boolean> {
  const { execution, panel, labels, ledger, push, errorText, pushMode, live, monitor, watchRef, setWatch, setWatchStatus, runDecision } = context;
  if (slash.command === 'monitor') {
    if (slash.args) return false;
    if (live.canOpenMonitor) await live.openMonitor();
    else {
      const title = labels.work?.live?.monitorTitle ?? '/monitor';
      let lines: readonly string[];
      const unwired = context.commandUnavailable ? fillTemplate(context.commandUnavailable, { part: 'monitor' }) : labels.work?.unavailable ?? labels.ledgerUnavailable;
      try { lines = monitor ? await monitor('') : [unwired]; }
      catch (error) { lines = [errorText(error)]; }
      await panel.pick(execution, { kind: 'window', title, body: lines, hints: labels.work?.jobs?.hints ?? '', confirm: false }, ['close']);
      push([systemSummaryEntry(labels.work?.live?.closedMonitor ?? title)]);
    }
    return true;
  }
  if (slash.command === 'watch-stop') { live.close(); return true; }
  if (['workers', 'runs', 'run', 'transcript', 'cancel', 'approvals', 'watch-workers', 'watch-runs', 'tasks'].includes(slash.command)) {
    const workLabels = labels.work;
    try {
      const unavailable = !ledger || !workLabels?.jobs || !workLabels.live || (['runs', 'run', 'cancel', 'watch-runs'].includes(slash.command) && !ledger.listRunIds)
        || (slash.command === 'transcript' && !ledger.inspectTranscript) || (slash.command === 'cancel' && !ledger.cancelRun)
        || (slash.command === 'approvals' && (!ledger.listApprovalPage || !ledger.decideApproval));
      if (unavailable) {
        const title = `/${slash.command}`, text = workLabels?.unavailable ?? labels.ledgerUnavailable;
        await panel.pick(execution, { kind: 'window', title, body: [text], hints: workLabels?.jobs?.hints ?? '', confirm: false }, ['close']);
        push([systemSummaryEntry(text)]); return true;
      }
      if (slash.command === 'approvals' || slash.command === 'cancel') await runDecision(slash.command, '', execution);
      else if (['watch-workers', 'watch-runs', 'tasks'].includes(slash.command)) {
        const action = immediateSlashAction(slash.command, { ledger, labels, watch: watchRef.current })!;
        if (action.watch) { watchRef.current = action.watch; setWatch(action.watch); }
        const feed = ledger!.followEvents || (slash.command === 'watch-runs' ? ledger!.followRuns : ledger!.followWorkers);
        // A refused or uninitialized feed delivers nothing, so the window names no delivery mode then (the refusal is its status line).
        const refused = pushMode === 'denied' || pushMode === 'not-initialized';
        setWatchStatus(refused ? '' : fillTemplate(workLabels!.jobs!.watchStatus, { mode: feed && pushMode !== 'poll' ? workLabels!.jobs!.push : workLabels!.jobs!.poll }));
        if (action.window) live.show(action.window);
      } else {
        const summary = await runJobWindow(slash.command as 'workers' | 'runs' | 'run' | 'transcript', panel, execution, ledger!, workLabels!);
        if (!execution.signal.aborted) push([systemSummaryEntry(summary)]);
      }
    } catch (error) {
      await panel.pick(execution, { kind: 'window', title: `/${slash.command}`, body: [errorText(error)], hints: workLabels?.jobs?.hints ?? '', confirm: false }, ['close']);
      if (!execution.signal.aborted) push([systemSummaryEntry(errorText(error))]);
    }
    return true;
  }
  return false;
}
