import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { systemSummaryEntry, LiveWatchWindow, MonitorWindow, liveWindowClosedText, type LiveWindowKind, type MonitorWindowLoader, type MonitorWindowRender, type WatchState,
  type WorkSurfaceLabels, type TaskWindowAction } from '#surfaces/core/terminal-work/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import { Window } from '#surfaces/core/terminal-window/index.js';
import { type WorkLedgerEntry, type WorkLedgerRunEntry, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal-ledger/index.js';

/**
 * The live windows of the workline (T3 L5): `/monitor`, `/watch-workers`, `/watch-runs` and `/tasks`. A watch window owns the observation
 * it shows (updated in place, no cards in the scrollback) and the watch it started: closing the window stops that watch and leaves one
 * summary line in the scrollback. Only one live window is open at a time; approval windows still stack above it (window stack priority).
 */
export function useLiveWindows({ work, workers, watch, watchRef, setWatch, push, errorText, monitorWindow, positionLabel, status, statusLines, onTaskAction }: {
  readonly work: WorkSurfaceLabels | undefined; readonly workers: readonly WorkLedgerWorkerEntry[]; readonly watch: WatchState;
  readonly watchRef: MutableRefObject<WatchState>; readonly setWatch: (watch: WatchState) => void;
  readonly push: (entries: readonly WorkLedgerEntry[]) => void; readonly errorText: (error: unknown) => string;
  readonly status?: string; readonly statusLines?: readonly string[];
  readonly monitorWindow?: MonitorWindowLoader | undefined; readonly positionLabel: string;
  readonly onTaskAction?: (action: TaskWindowAction) => void;
}) {
  const [kind, setKind] = useState<LiveWindowKind | null>(null);
  const [runs, setRuns] = useState<readonly WorkLedgerRunEntry[]>([]);
  const [monitor, setMonitor] = useState<MonitorWindowRender | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useRef({ kind, workers, runs, work });
  latest.current = { kind, workers, runs, work };
  // The observed runs live only while the run watch does.
  useEffect(() => { if (!watch.runs) setRuns([]); }, [watch.runs]);
  const openMonitor = useCallback(async () => {
    try { const render = await monitorWindow!(); setFailure(null); setMonitor(() => render); setKind('monitor'); }
    catch (error) { setFailure(errorText(error)); setKind('monitor'); }
  }, [errorText, monitorWindow]);
  const close = useCallback((reason?: string) => {
    const current = latest.current;
    if (!current.kind) return;
    latest.current = { ...current, kind: null }; setKind(null);
    if (current.kind === 'monitor') { if (current.work?.live) push([systemSummaryEntry(current.work.live.closedMonitor ?? current.work.live.monitorTitle)]); return; }
    const off: WatchState = { workers: false, runs: false };
    watchRef.current = off; setWatch(off);
    if (current.work?.live) push([systemSummaryEntry([reason, liveWindowClosedText(current.kind, { workers: current.workers, runs: current.runs }, current.work.live)].filter(Boolean).join(' · '))]);
  }, [push, setWatch, watchRef]);
  /** Opens (or, with `null`, drops) a watch window; the watch flags are the caller's (`immediateSlashAction`). */
  const show = useCallback((next: Exclude<LiveWindowKind, 'monitor'> | null) => { if (next === null) { close(); return; } setFailure(null); latest.current = { ...latest.current, kind: next }; setKind(next); }, [close]);
  const live = work?.live;
  const element = !live || !work || kind === null ? null : kind === 'monitor'
    ? (failure ? <Window title={[span(live.monitorTitle)]} body={[{ spans: [span(failure, { role: 'error' })] }]} hints={live.monitorHints} position={positionLabel} onClose={close} /> : monitor ? <MonitorWindow render={monitor} labels={live} onClose={close} /> : null)
    : <LiveWatchWindow kind={kind} data={{ workers, runs }} labels={{ live, panel: work.panel, workerLine: work.workerLine, jobs: work.jobs }} position={positionLabel} statusText={status} statusLines={statusLines} onClose={close} onAction={onTaskAction} />;
  const isOpen = useCallback(() => latest.current.kind !== null, []);
  return { show, openMonitor, close, isOpen, setRuns, element, canOpenMonitor: Boolean(monitorWindow && live) };
}
