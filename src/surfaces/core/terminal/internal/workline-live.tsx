import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { LiveWatchWindow, MonitorWindow, liveWindowClosedText, type LiveWindowKind, type MonitorWindowLoader, type MonitorWindowRender, type WatchState,
  type WorkSurfaceLabels } from '#surfaces/core/terminal-work/index.js';
import { notice, type WorkLedgerEntry, type WorkLedgerRunEntry, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal-ledger/index.js';

/**
 * The live windows of the workline (T3 L5): `/monitor`, `/watch-workers`, `/watch-runs` and `/tasks`. A watch window owns the observation
 * it shows (updated in place, no cards in the scrollback) and the watch it started: closing the window stops that watch and leaves one
 * summary line in the scrollback. Only one live window is open at a time; approval windows still stack above it (window stack priority).
 */
export function useLiveWindows({ work, workers, watch, watchRef, setWatch, push, errorText, monitorWindow, positionLabel }: {
  readonly work: WorkSurfaceLabels | undefined; readonly workers: readonly WorkLedgerWorkerEntry[]; readonly watch: WatchState;
  readonly watchRef: MutableRefObject<WatchState>; readonly setWatch: (watch: WatchState) => void;
  readonly push: (entries: readonly WorkLedgerEntry[]) => void; readonly errorText: (error: unknown) => string;
  readonly monitorWindow?: MonitorWindowLoader | undefined; readonly positionLabel: string;
}) {
  const [kind, setKind] = useState<LiveWindowKind | null>(null);
  const [runs, setRuns] = useState<readonly WorkLedgerRunEntry[]>([]);
  const [monitor, setMonitor] = useState<MonitorWindowRender | null>(null);
  const latest = useRef({ kind, workers, runs, work });
  latest.current = { kind, workers, runs, work };
  // The observed runs live only while the run watch does.
  useEffect(() => { if (!watch.runs) setRuns([]); }, [watch.runs]);
  /** Opens (or, with `null`, drops) a watch window; the watch flags are the caller's (`immediateSlashAction`). */
  const show = useCallback((next: Exclude<LiveWindowKind, 'monitor'> | null) => { setKind(next); }, []);
  const openMonitor = useCallback(async () => {
    try { const render = await monitorWindow!(); setMonitor(() => render); setKind('monitor'); }
    catch (error) { push([notice('error', `${latest.current.work?.live?.monitorFailed ?? ''}${latest.current.work?.live ? ': ' : ''}${errorText(error)}`)]); }
  }, [errorText, monitorWindow, push]);
  const close = useCallback(() => {
    const current = latest.current;
    setKind(null);
    if (!current.kind || current.kind === 'monitor') return;
    const off: WatchState = { workers: false, runs: false };
    watchRef.current = off; setWatch(off);
    if (current.work?.live) push([notice('info', liveWindowClosedText(current.kind, { workers: current.workers, runs: current.runs }, current.work.live))]);
  }, [push, setWatch, watchRef]);
  const live = work?.live;
  const element = !live || !work || kind === null ? null : kind === 'monitor'
    ? (monitor ? <MonitorWindow render={monitor} labels={live} onClose={close} /> : null)
    : <LiveWatchWindow kind={kind} data={{ workers, runs }} labels={{ live, panel: work.panel, workerLine: work.workerLine }} position={positionLabel} onClose={close} />;
  return { show, openMonitor, close, setRuns, element, canOpenMonitor: Boolean(monitorWindow && live) };
}
