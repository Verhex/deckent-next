import type { ProgressionCursor } from './journal.js';
import type { RunProgressionTurn } from './turn.js';
type Page = Readonly<{ items: readonly ProgressionCursor[]; next: ProgressionCursor | null }>;
export interface RunLifecycleRuntimeOperations {
  discover(after: ProgressionCursor | null, dueAfter: ProgressionCursor | null, now: number): Promise<{ page: Page; due: Page }>;
  advance(query: ProgressionCursor, signal: AbortSignal): ReturnType<RunProgressionTurn['advance']>;
  expire(query: ProgressionCursor): Promise<void>;
}
export interface RunLifecycleRuntimeObserver {
  onRun?(query: ProgressionCursor, result: Awaited<ReturnType<RunProgressionTurn['advance']>>): void | Promise<void>;
  onError?(query: ProgressionCursor | null, error: unknown): void | Promise<void>;
}
/** One bounded lifecycle driver. Parked Runs only enter the deadline page; each page retains its own fair cursor. */
export class RunLifecycleRuntimeLoop {
  private running = false;
  constructor(private readonly operations: RunLifecycleRuntimeOperations, private readonly observer: RunLifecycleRuntimeObserver,
    private readonly settings: { pollIntervalMs: number; failureBackoffMs: number }, private readonly now: () => number = Date.now) {}
  async run(signal: AbortSignal) {
    if (this.running) throw new Error('RUN_RUNTIME_ALREADY_RUNNING');
    this.running = true;
    let cursor: ProgressionCursor | null = null, dueCursor: ProgressionCursor | null = null;
    try {
      await wait(this.settings.pollIntervalMs, signal);
      while (!signal.aborted) {
        let failed = false;
        try {
          const { page, due } = await this.operations.discover(cursor, dueCursor, this.now());
          cursor = page.next; dueCursor = due.next;
          for (const query of due.items) {
            if (signal.aborted) break;
            try { await this.operations.expire(query); }
            catch (error) { failed = true; await this.observer.onError?.(query, error); }
          }
          for (const query of page.items) {
            if (signal.aborted) break;
            try { const result = await this.operations.advance(query, signal); await this.observer.onRun?.(query, result); }
            catch (error) { failed = true; await this.observer.onError?.(query, error); }
          }
        } catch (error) { failed = true; cursor = null; dueCursor = null; await this.observer.onError?.(null, error); }
        if (!signal.aborted) await wait(failed ? this.settings.failureBackoffMs : this.settings.pollIntervalMs, signal);
      }
    } finally { this.running = false; }
  }
}
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds); signal.addEventListener('abort', finish, { once: true });
  });
}
