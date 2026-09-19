export interface ScopedRuntimeLoopOptions { readonly scopeIds: readonly string[]; readonly pollIntervalMs: number; readonly failureBackoffMs: number }
export interface ScopedRuntimeLoopClock { now(): number }
export type ScopedRuntimeLoopWait = (milliseconds: number, signal: AbortSignal) => Promise<void>;
export interface ScopedRuntimeLoopObserver<Command, Result> {
  onPage(command: Command, result: Result): void | Promise<void>;
  onError(command: Command, error: unknown): void | Promise<void>;
}
export interface ScopedRuntimeLoopContract<Command, Result> {
  command(scopeId: string, cursor: string | null): Command;
  nextCursor(result: Result): string | null;
  unavailable(result: Result): boolean;
}

/** One bounded page per eligible scope per cycle; abort stops new pages but never abandons an active page. */
export class ScopedRuntimeLoop<Command, Result> {
  private readonly cursors = new Map<string, string | null>();
  private readonly retryNotBefore = new Map<string, number>();
  private running: Promise<void> | null = null;
  constructor(private readonly drain: (command: Command) => Promise<Result>, private readonly wait: ScopedRuntimeLoopWait,
    private readonly clock: ScopedRuntimeLoopClock, private readonly observer: ScopedRuntimeLoopObserver<Command, Result>,
    private readonly options: ScopedRuntimeLoopOptions, private readonly contract: ScopedRuntimeLoopContract<Command, Result>,
    private readonly runningError: () => Error) {
    for (const scopeId of options.scopeIds) this.cursors.set(scopeId, null);
  }
  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw this.runningError();
    const work = this.drainUntilStopped(signal); this.running = work;
    try { await work; } finally { this.running = null; }
  }
  private async drainUntilStopped(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      for (const scopeId of this.options.scopeIds) {
        if (signal.aborted) break;
        if ((this.retryNotBefore.get(scopeId) ?? 0) > this.clock.now()) continue;
        const command = this.contract.command(scopeId, this.cursors.get(scopeId) ?? null);
        let result: Result;
        try { result = await this.drain(command); }
        catch (error) {
          this.cursors.set(scopeId, null);
          this.retryNotBefore.set(scopeId, this.clock.now() + this.options.failureBackoffMs);
          await this.observer.onError(command, error);
          continue;
        }
        this.cursors.set(scopeId, this.contract.nextCursor(result));
        if (this.contract.unavailable(result)) {
          this.cursors.set(scopeId, null);
          this.retryNotBefore.set(scopeId, this.clock.now() + this.options.failureBackoffMs);
        } else this.retryNotBefore.delete(scopeId);
        await this.observer.onPage(command, result);
      }
      if (!signal.aborted) await this.wait(this.options.pollIntervalMs, signal);
    }
  }
}
