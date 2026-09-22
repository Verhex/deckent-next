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
