import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useInput } from 'ink';
import { systemSummaryEntry, RunsLiveWindow, MonitorWindow, liveWindowClosedText, type LiveWindowKind, type MonitorWindowLoader, type MonitorWindowRender, type WatchState,
  type WorkSurfaceLabels, type TaskWindowAction, type RunsRowOffer, type RunsWindowView, RUNS_WINDOW_INITIAL } from '#surfaces/core/terminal-work/index.js';
import { useFocusOwner } from '#surfaces/core/terminal-window/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import { Window, WindowOpeningContext } from '#surfaces/core/terminal-window/index.js';

const NO_ROW_KEYS: RunsRowOffer = Object.freeze({ cancel: false, control: false, answer: false, deliverable: () => false });
import { type WorkLedgerEntry, type WorkLedgerRunEntry, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal-ledger/index.js';

/**
 * The live windows of the workline (T3 L5, K1): `/monitor` and the one Runs window. The Runs window owns the observation it shows (updated in
 * place, no cards in the scrollback) and the watch it started: closing it stops that watch and leaves one summary line in the scrollback.
 * Only one live window is open at a time; approval windows still stack above it (window stack priority). K5: Ctrl+X closes it from the
 * input without focusing it (Esc closes it when focused; Ctrl+O and Ctrl+T keep their meaning).
 */
export function useLiveWindows({ work, workers, watch, watchRef, setWatch, push, errorText, monitorWindow, positionLabel, status, statusLines, onTaskAction, offer = NO_ROW_KEYS }: {
  readonly work: WorkSurfaceLabels | undefined; readonly workers: readonly WorkLedgerWorkerEntry[]; readonly watch: WatchState;
  readonly watchRef: MutableRefObject<WatchState>; readonly setWatch: (watch: WatchState) => void;
  readonly push: (entries: readonly WorkLedgerEntry[]) => void; readonly errorText: (error: unknown) => string;
  readonly status?: string; readonly statusLines?: readonly string[];
  readonly monitorWindow?: MonitorWindowLoader | undefined; readonly positionLabel: string;
  readonly onTaskAction?: (action: TaskWindowAction) => void;
  /** The row keys this terminal can offer (its ports and words); absent: Enter only. */
  readonly offer?: RunsRowOffer;
}) {
  const [kind, setKind] = useState<LiveWindowKind | null>(null);
  const [opening, setOpening] = useState<'foreground' | 'background'>('foreground');
  const [runs, setRuns] = useState<readonly WorkLedgerRunEntry[]>([]);
  const [monitor, setMonitor] = useState<MonitorWindowRender | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The Runs window's tab and selection outlive a card that covers it; a new opening starts on the runs tab.
  const [runsView, setRunsView] = useState<RunsWindowView>(RUNS_WINDOW_INITIAL);
  const latest = useRef({ kind, workers, runs, work });
  latest.current = { kind, workers, runs, work };
  // The observed runs live only while the run watch does.
  useEffect(() => { if (!watch.runs) setRuns([]); }, [watch.runs]);
  const openMonitor = useCallback(async () => {
    setOpening('foreground');
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
    if (current.work?.live) push([systemSummaryEntry([reason, liveWindowClosedText({ workers: current.workers, runs: current.runs }, current.work.live)].filter(Boolean).join(' · '))]);
  }, [push, setWatch, watchRef]);

  /** Opens (or, with `null`, drops) a watch window; the watch flags are the caller's (`immediateSlashAction`). */
  const show = useCallback((next: Exclude<LiveWindowKind, 'monitor'> | null, cause: 'foreground' | 'background' = 'foreground') => {
    if (next === null) { close(); return; } if (latest.current.kind === null) setRunsView(RUNS_WINDOW_INITIAL); setOpening(cause); setFailure(null); latest.current = { ...latest.current, kind: next }; setKind(next);
  }, [close]);
  const live = work?.live;
  const element = !live || !work || kind === null ? null : kind === 'monitor'
    ? (failure ? <Window title={[span(live.monitorTitle)]} body={[{ spans: [span(failure, { role: 'error' })] }]} hints={live.monitorHints} position={positionLabel} onClose={close} /> : monitor ? <MonitorWindow render={monitor} labels={live} onClose={close} /> : null)
    : <RunsLiveWindow data={{ workers, runs }} labels={{ live, panel: work.panel, workerLine: work.workerLine, jobs: work.jobs, runControl: work.runControl }} position={positionLabel} statusText={status}
      statusLines={statusLines} offer={offer} onClose={close} onAction={onTaskAction} view={runsView} onView={setRunsView} runsUnavailable={watch.runs ? undefined : work.unavailable} />;
  const isOpen = useCallback(() => latest.current.kind !== null, []);
  return { show, openMonitor, close, isOpen, keys: <LiveWindowCloseKey open={kind !== null} onClose={close} />, setRuns, element: <WindowOpeningContext.Provider value={opening}>{element}</WindowOpeningContext.Provider>, canOpenMonitor: Boolean(monitorWindow && live) };
}

/**
 * K5: Ctrl+X closes the open live window while the composer holds input — it is not composer text, Esc stays the turn's cancel there and
 * Ctrl+O / Ctrl+T keep their meaning. A focused card or window owns the keyboard, so the chord never acts behind a decision. Rendered inside
 * the `WindowStackProvider`.
 */
export function LiveWindowCloseKey({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): null {
  const owner = useFocusOwner();
  useInput((input, key) => { if (key.ctrl && !key.meta && input === 'x') onClose(); }, { isActive: open && owner.composing });
  return null;
}
