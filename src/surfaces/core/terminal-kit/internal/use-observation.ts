import { useEffect, useRef } from 'react';

/**
 * Observe-only polling: one poll in flight at a time (the next is scheduled after the previous settles), results
 * from a stopped watch are discarded, and a failure streak is reported once until a poll succeeds again.
 */
export function useSingleFlightPoll(enabled: boolean, intervalMs: number, task: (current: () => boolean) => Promise<void>,
  onFailure: (error: unknown) => void): void {
  const taskRef = useRef(task);
  const failureRef = useRef(onFailure);
  taskRef.current = task;
  failureRef.current = onFailure;
  useEffect(() => {
    if (!enabled) return;
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
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
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
