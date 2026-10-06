/** Environment name by which a launcher marks a service it started on its own (never read from configuration: it is a fact of this launch). */
export const RUNTIME_SERVICE_AUTOSTART_ENV = 'DECKENT_RUNTIME_AUTOSTARTED';
/** A connected terminal describes the service this often so a quiet but open session counts as activity: one third of the smallest
 * configurable idle period (`service.idleShutdown.afterMs` minimum 60 s), so even a missed beat leaves margin. */
export const RUNTIME_SERVICE_HEARTBEAT_MS = 20_000;
export interface RuntimeServiceIdleOptions {
  /** True only for a service the interactive terminal started automatically; any other service never stops by idleness. */
  readonly autoStarted: boolean;
  /** Idle period; null disables the policy. */
  readonly afterMs: number | null;
  readonly now: () => number;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
/**
 * K6 = A: idle means no admitted request or background execution is in flight and none has finished for `afterMs`. Clients connect per
 * request, so a quiet terminal is kept alive by its own describe heartbeat, not by an open socket. Pure policy: the owner decides what
 * "stop" does (the service's existing governed stop path).
 */
export class RuntimeServiceIdlePolicy {
  private active = 0;
  private lastActivity: number;
  constructor(private readonly options: RuntimeServiceIdleOptions) { this.lastActivity = options.now(); }
  get enabled(): boolean { return this.options.autoStarted && this.options.afterMs !== null; }
  /** Marks one unit of work in flight until the returned release runs (idempotent). */
  begin(): () => void {
    this.active++; let released = false;
    return () => { if (released) return; released = true; this.active--; this.lastActivity = this.options.now(); };
  }
  async track<T>(work: () => Promise<T> | T): Promise<T> { const release = this.begin(); try { return await work(); } finally { release(); } }
  /** Resolves `idle` when the deadline passed with nothing in flight, `aborted` when the signal ended first (or the policy is off). */
  async run(signal: AbortSignal): Promise<'idle' | 'aborted'> {
    const afterMs = this.options.afterMs;
    if (!this.enabled || afterMs === null) return 'aborted';
    while (!signal.aborted) {
      const remaining = this.active > 0 ? afterMs : this.lastActivity + afterMs - this.options.now();
      if (remaining <= 0) return 'idle';
      await this.options.wait(remaining, signal);
    }
    return 'aborted';
  }
}
