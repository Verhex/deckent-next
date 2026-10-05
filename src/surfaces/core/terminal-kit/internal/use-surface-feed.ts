import { useEffect, useRef, useState } from 'react';
import { createSurfaceFollowSession, type SurfaceDeliveryMode, type SurfacePushEvent, type SurfacePushStep } from './surface-push.js';

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
 * reports a gap for every kind already applied, then opens `follow` again. Abort does not poll.
 */
export function useSurfacePushFeed(
  follow: ((signal: AbortSignal) => AsyncIterable<SurfacePushEvent>) | undefined,
  scopeId: string,
  pace: number,
  onStep: (step: SurfacePushStep) => void,
  onDelivery: (mode: SurfaceDeliveryMode) => void,
): boolean {
  const [live, setLive] = useState(Boolean(follow));
  const stepRef = useRef(onStep);
  const deliveryRef = useRef(onDelivery);
  stepRef.current = onStep;
  deliveryRef.current = onDelivery;
  useEffect(() => {
    if (!follow || scopeId.length === 0) { setLive(false); return undefined; }
    const session = createSurfaceFollowSession();
    const controller = new AbortController();
    let stopped = false;
    const run = async () => {
      while (!stopped && !controller.signal.aborted) {
        setLive(true);
        try {
          const outcome = await session.read(follow(controller.signal), scopeId, pace, controller.signal, step => { if (!stopped) stepRef.current(step); });
          if (stopped || outcome === 'abort' || controller.signal.aborted) return;
        } catch { if (stopped || controller.signal.aborted) return; }
        if (stopped || controller.signal.aborted) return;
        setLive(false);
        session.reportBreak(pace, step => { if (!stopped) stepRef.current(step); });
        deliveryRef.current('poll');
        await waitPace(pace, controller.signal);
        if (stopped || controller.signal.aborted) return;
        deliveryRef.current('push');
      }
    };
    void run();
    return () => { stopped = true; controller.abort(); };
  }, [follow, pace, scopeId]);
  return Boolean(follow) && live;
}
