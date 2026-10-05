import { useEffect, useRef, useState } from 'react';
import { openSurfacePush, surfaceWait, pollWait, createSurfaceFollowSession, type SurfaceDeliveryMode, type SurfaceFollowEvent, type SurfacePushStep, type SurfaceRefresh } from './surface-push.js';

/**
 * Observe-only polling: one poll in flight at a time (the next is scheduled after the previous settles), results
 * from a stopped watch are discarded, and a failure streak is reported once until a poll succeeds again.
 * Each scheduled wait is `poll-scope`, owned by `terminal-watch`, and times out at `intervalMs`.
 */
export function useSingleFlightPoll(enabled: boolean, intervalMs: number, task: (current: () => boolean) => Promise<void>,
  onFailure: (error: unknown) => void): void {
  const taskRef = useRef(task);
  const failureRef = useRef(onFailure);
  taskRef.current = task;
  failureRef.current = onFailure;
  useEffect(() => {
    if (!enabled) return;
    const wait = pollWait(intervalMs);
    let stopped = false;
    let failing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !stopped;
    const tick = async () => {
      try {
        await taskRef.current(current);
        failing = false;
      } catch (error) {
        if (!stopped && !failing) failureRef.current(error);
        failing = true;
      }
      if (!stopped) timer = setTimeout(() => void tick(), wait.timeoutMs);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [enabled, intervalMs]);
}

/** One subscription lifecycle; a late batch/failure from a stopped view cannot update its replacement. */
export function useWorklineFollow<T>(enabled: boolean, follow: ((signal: AbortSignal) => AsyncIterable<T>) | undefined,
  observe: (batch: T) => void, onFailure: (error: unknown) => void) {
  const handlers = useRef({ observe, onFailure }); handlers.current = { observe, onFailure };
  useEffect(() => {
    if (!enabled || !follow) return;
    const controller = new AbortController();
    void (async () => {
      try { for await (const batch of follow(controller.signal)) { if (controller.signal.aborted) return; handlers.current.observe(batch); } }
      catch (error) { if (!controller.signal.aborted) handlers.current.onFailure(error); }
    })();
    return () => { controller.abort(); };
  }, [enabled, follow]);
}

function waitPace(pace: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(finish, pace);
    function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Push while `follow` yields. A throw or a clean close (the stream is gone) switches the watch to poll,
 * reports a gap for every kind already applied, then opens `follow` again. Access denial stops without retry/poll; abort does not poll.
 */
export function useSurfacePushFeed(
  follow: ((signal: AbortSignal) => AsyncIterable<SurfaceFollowEvent>) | undefined,
  scopeId: string,
  pace: number,
  onStep: (step: SurfacePushStep) => void,
  onDelivery: (mode: SurfaceDeliveryMode) => void,
  refresh?: SurfaceRefresh,
  refreshKey = '',
): SurfaceDeliveryMode {
  const deniedSource = useRef<{ follow: typeof follow; scopeId: string } | null>(null);
  const [mode, setMode] = useState<SurfaceDeliveryMode>(follow ? 'push' : 'poll');
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  const stepRef = useRef(onStep);
  const deliveryRef = useRef(onDelivery);
  stepRef.current = onStep;
  deliveryRef.current = onDelivery;
  const hasRefresh = Boolean(refresh);
  useEffect(() => {
    if (!follow || scopeId.length === 0) { setMode('poll'); return undefined; }
    if (deniedSource.current?.follow === follow && deniedSource.current.scopeId === scopeId) { setMode('denied'); return undefined; }
    const deny = () => { deniedSource.current = { follow, scopeId }; setMode('denied'); };
    const session = createSurfaceFollowSession();
    const controller = new AbortController();
    let stopped = false;
    const run = async () => {
      while (!stopped && !controller.signal.aborted) {
        setMode('push');
        try {
          const outcome = await session.read(follow(controller.signal), scopeId, pace, controller.signal, step => { if (!stopped) stepRef.current(step); }, hasRefresh ? (kinds, signal) => refreshRef.current!(kinds, signal) : undefined);
          if (stopped || outcome === 'abort' || controller.signal.aborted) return;
          if (outcome === 'denied') { deny(); return; }
        } catch { if (stopped || controller.signal.aborted) return; }
        if (stopped || controller.signal.aborted) return;
        setMode('poll');
        session.reportBreak(pace, step => { if (!stopped) stepRef.current(step); });
        deliveryRef.current('poll');
        if (hasRefresh) {
          try {
            const denied = await refreshRef.current!(session.allowedKinds(), controller.signal);
            if (stopped || controller.signal.aborted) return;
            if (denied.length) {
              stepRef.current({ status: 'denied', access: 'denied', scopeId, kinds: denied, stopped: true, state: openSurfacePush(), wait: surfaceWait('refuse-scope', pace) });
              deny(); return;
            }
          } catch { if (stopped || controller.signal.aborted) return; }
        }
        await waitPace(pace, controller.signal);
        if (stopped || controller.signal.aborted) return;
        deliveryRef.current('push');
      }
    };
    void run();
    return () => { stopped = true; controller.abort(); };
  }, [follow, pace, scopeId, hasRefresh, refreshKey]);
  return follow ? mode : 'poll';
}

/** One observe callback for the same typed batch, whichever transport is available. */
export function useWorklineWatch<T>(enabled: boolean, follow: ((signal: AbortSignal) => AsyncIterable<T>) | undefined,
  pace: number, read: () => Promise<T>, observe: (batch: T) => void, failed: (error: unknown) => void) {
  useWorklineFollow(enabled, follow, observe, failed);
  useSingleFlightPoll(enabled && !follow, pace, async current => {
    const batch = await read();
    if (current()) observe(batch);
  }, failed);
}
