import { parseSlashLine } from './slash-registry.js';
/** BeUser D-05: the open terminal's heartbeat `describe` of the runtime service also notices the service stopping under it. Each listener hears
 * `text()` once per absence (a describe refused LOCAL_RUNTIME_UNAVAILABLE after one that answered); a service never reached is not "stopped".
 * alpha.60 B: the opening's start settles after the first frame, so the watch is armed (`arm`) once that start answered. */
export function serviceAbsenceWatch(describe: () => Promise<unknown>, reached: boolean, text: () => string) {
  const listeners = new Set<(text: string) => void>(); let absent = !reached;
  return {
    subscribe(listener: (text: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    arm() { absent = false; },
    tick: () => describe().then(() => { absent = false; }, (error: unknown) => {
      if ((error as { code?: unknown } | null)?.code !== 'LOCAL_RUNTIME_UNAVAILABLE' || absent) return;
      absent = true; for (const listener of listeners) listener(text());
    }),
  };
}
/**
 * alpha.60 B (P3 draw-first): the send gate of the opened view. Until `ready` settles (the runtime service answered and the first mode read
 * settled) a line waits behind one visible notice; the controller runs one line at a time, so the order is kept. The line's own cancel (Ctrl+C)
 * ends the wait and nothing is sent. A start that failed meanwhile (the autostart's LifecycleDeadline included) rejects the waiting line with its
 * typed error; lines after it meet their own checks (BeUser M-09 start). `/exit` and `/quit` never wait: they send nothing.
 */
export function openingGate(ready: Promise<unknown>) {
  let settled = false;
  ready.then(() => { settled = true; }, () => { settled = true; });
  return async (line: string, signal: AbortSignal, waiting: () => void): Promise<boolean> => {
    const command = parseSlashLine(line)?.command;
    if (settled || command === 'exit' || command === 'quit') return !signal.aborted;
    waiting();
    const cancelled = new Promise<false>(resolve => { if (signal.aborted) resolve(false); else signal.addEventListener('abort', () => resolve(false), { once: true }); });
    return await Promise.race([ready.then(() => true), cancelled]) && !signal.aborted;
  };
}
