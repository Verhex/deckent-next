import { z } from 'zod';
import type { ProgressionCursor } from './journal.js';
import type { RunProgressionTurn } from './turn.js';
type Page = Readonly<{ items: readonly ProgressionCursor[]; next: ProgressionCursor | null }>;
/** A scope the discovery left out because it is not this installation's own (pinned to another company, or not registered). */
export type SkippedProgressionScope = Readonly<{ scopeId: string; reason: 'foreign' | 'unregistered' }>;
export interface RunLifecycleRuntimeOperations {
  discover(after: ProgressionCursor | null, dueAfter: ProgressionCursor | null, now: number): Promise<{ page: Page; due: Page; skipped?: readonly SkippedProgressionScope[] }>;
  advance(query: ProgressionCursor, signal: AbortSignal): ReturnType<RunProgressionTurn['advance']>;
  expire(query: ProgressionCursor): Promise<void>;
}
export interface RunLifecycleRuntimeObserver {
  onRun?(query: ProgressionCursor, result: Awaited<ReturnType<RunProgressionTurn['advance']>>): void | Promise<void>;
  onError?(query: ProgressionCursor | null, error: unknown): void | Promise<void>;
  /** Typed note, once per scope while the loop lives: the scope is skipped by discovery and never advanced here. */
  onScopeSkipped?(scope: SkippedProgressionScope): void | Promise<void>;
}
/** Bounded concurrent Run turns, retained across discovery polls and drained on shutdown.
 * A failing Run backs off on its own (`failureBackoffMs`); other Runs keep their turns. Only a failed discovery pauses the whole loop.
 * Parked Runs only enter the deadline page; each page retains its own fair cursor. No queued page backlog.
 */
export class RunLifecycleRuntimeLoop {
  private running = false;
  private readonly concurrency: number;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly retryNotBefore = new Map<string, number>();
  private readonly notedScopes = new Set<string>();
  constructor(private readonly operations: RunLifecycleRuntimeOperations, private readonly observer: RunLifecycleRuntimeObserver,
    private readonly settings: { pollIntervalMs: number; failureBackoffMs: number; maxConcurrentRuns?: number }, private readonly now: () => number = Date.now) {
    this.concurrency = z.number().int().positive().safe().parse(settings.maxConcurrentRuns ?? 1);
  }
  private key(query: ProgressionCursor) { return JSON.stringify([query.scopeId, query.runId]); }
  private async report(query: ProgressionCursor | null, error: unknown) {
    // An observer failure cannot lose custody or terminate unrelated Run turns.
    try { await this.observer.onError?.(query, error); } catch { /* Reporting has no execution authority. */ }
  }
  private backedOff(query: ProgressionCursor) { return (this.retryNotBefore.get(this.key(query)) ?? 0) > this.now(); }
  private async noteSkipped(skipped: readonly SkippedProgressionScope[] | undefined) {
    for (const scope of skipped ?? []) {
      if (this.notedScopes.has(scope.scopeId)) continue;
      this.notedScopes.add(scope.scopeId);
      try { await this.observer.onScopeSkipped?.(scope); } catch { /* A note has no execution authority. */ }
    }
  }
  async run(signal: AbortSignal) {
    if (this.running) throw new Error('RUN_RUNTIME_ALREADY_RUNNING');
    this.running = true;
    let cursor: ProgressionCursor | null = null, dueCursor: ProgressionCursor | null = null, backoffUntil = 0; // backoffUntil: failed discovery only
    try {
      await wait(this.settings.pollIntervalMs, signal);
      while (!signal.aborted) {
        if (backoffUntil > this.now()) { await wait(backoffUntil - this.now(), signal); continue; }
        try {
          const { page, due, skipped } = await this.operations.discover(cursor, dueCursor, this.now());
          for (const [key, until] of this.retryNotBefore) if (until <= this.now()) this.retryNotBefore.delete(key);
          await this.noteSkipped(skipped);
          // The page cursor advances only past Runs this poll actually visited: a page met with a full bound is re-read next poll (Fable R1).
          const previous: ProgressionCursor | null = cursor;
          cursor = page.next; dueCursor = due.next;
          for (const query of due.items) {
            if (signal.aborted) break;
            if (this.inFlight.has(this.key(query))) continue;
            try { await this.operations.expire(query); }
            catch (error) { await this.report(query, error); }
          }
          // A failed turn parks only its own Run (retryNotBefore); the driver and every other Run keep going.
          let visited: ProgressionCursor | null = null;
          for (const query of page.items) {
            if (signal.aborted || this.inFlight.size >= this.concurrency) {
              cursor = visited ?? previous;
              break;
            }
            visited = query;
            const key = this.key(query);
            if (this.inFlight.has(key) || this.backedOff(query)) continue;
            const work = Promise.resolve().then(async () => {
              try {
                let result: Awaited<ReturnType<RunProgressionTurn['advance']>>;
                try { result = await this.operations.advance(query, signal); }
                catch (error) { this.retryNotBefore.set(key, this.now() + this.settings.failureBackoffMs); await this.report(query, error); return; }
                this.retryNotBefore.delete(key);
                try { await this.observer.onRun?.(query, result); }
                catch (error) { await this.report(query, error); }
              } finally {
                this.inFlight.delete(key);
              }
            });
            this.inFlight.set(key, work);
          }
        } catch (error) {
          cursor = null; dueCursor = null;
          backoffUntil = Math.max(backoffUntil, this.now() + this.settings.failureBackoffMs);
          await this.report(null, error);
        }
        if (!signal.aborted) await wait(Math.max(this.settings.pollIntervalMs, backoffUntil - this.now()), signal);
      }
    } finally { await Promise.allSettled(this.inFlight.values()); this.running = false; }
  }
}
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds); signal.addEventListener('abort', finish, { once: true });
  });
}
