/** BeUser D-05: the open terminal's heartbeat `describe` of the runtime service also notices the service stopping under it. Each listener hears
 * `text()` once per absence (a describe refused LOCAL_RUNTIME_UNAVAILABLE after one that answered); a service never reached is not "stopped". */
export function serviceAbsenceWatch(describe: () => Promise<unknown>, reached: boolean, text: () => string) {
  const listeners = new Set<(text: string) => void>(); let absent = !reached;
  return {
    subscribe(listener: (text: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    tick: () => describe().then(() => { absent = false; }, (error: unknown) => {
      if ((error as { code?: unknown } | null)?.code !== 'LOCAL_RUNTIME_UNAVAILABLE' || absent) return;
      absent = true; for (const listener of listeners) listener(text());
    }),
  };
}
