import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import type { CancellationRecoveryCommand } from '#engine/core/runs/index.js';

const loopOptionsSchema = z.object({ scopeIds: z.array(identitySchema).min(1), pollIntervalMs: z.number().int().positive().safe(),
  failureBackoffMs: z.number().int().positive().safe() }).strict();
export type CancellationRuntimeLoopOptions = Readonly<z.infer<typeof loopOptionsSchema>>;
export type CancellationRecoveryPageResult = Readonly<{ nextAfterAttemptId: string | null;
  outcomes?: readonly Readonly<{ outcome: Readonly<{ status: string }> }>[] }>;
export type CancellationRecoveryDrain = (command: CancellationRecoveryCommand) => Promise<CancellationRecoveryPageResult>;
export interface CancellationRuntimeLoopObserver {
  onPage(command: CancellationRecoveryCommand, result: CancellationRecoveryPageResult): void | Promise<void>;
  onError(command: CancellationRecoveryCommand, error: unknown): void | Promise<void>;
}
export type CancellationRuntimeWait = (milliseconds: number, signal: AbortSignal) => Promise<void>;
export interface CancellationRuntimeClock { now(): number }
export class CancellationRuntimeLoopError extends Error {
  constructor(readonly code: 'CANCELLATION_RUNTIME_LOOP_OPTIONS' | 'CANCELLATION_RUNTIME_LOOP_RUNNING') { super(code); this.name = 'CancellationRuntimeLoopError'; }
}

/** Trusted host lifecycle helper: drains at most one recovery page per scope per cycle. */
export class CancellationRuntimeLoop {
  private readonly scopeIds: readonly string[];
  private readonly pollIntervalMs: number;
  private readonly failureBackoffMs: number;
  private readonly cursors = new Map<string, string | null>();
  private readonly retryNotBefore = new Map<string, number>();
  private running: Promise<void> | null = null;
  constructor(private readonly drain: CancellationRecoveryDrain, private readonly wait: CancellationRuntimeWait,
    private readonly clock: CancellationRuntimeClock, private readonly observer: CancellationRuntimeLoopObserver, options: CancellationRuntimeLoopOptions) {
    let parsed;
    try { parsed = loopOptionsSchema.parse(options); }
    catch { throw new CancellationRuntimeLoopError('CANCELLATION_RUNTIME_LOOP_OPTIONS'); }
    if (new Set(parsed.scopeIds).size !== parsed.scopeIds.length) throw new CancellationRuntimeLoopError('CANCELLATION_RUNTIME_LOOP_OPTIONS');
    this.scopeIds = Object.freeze([...parsed.scopeIds]); this.pollIntervalMs = parsed.pollIntervalMs; this.failureBackoffMs = parsed.failureBackoffMs;
    for (const scopeId of this.scopeIds) this.cursors.set(scopeId, null);
  }
  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new CancellationRuntimeLoopError('CANCELLATION_RUNTIME_LOOP_RUNNING');
    const work = this.drainUntilStopped(signal); this.running = work;
    try { await work; } finally { this.running = null; }
  }
  private async drainUntilStopped(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      for (const scopeId of this.scopeIds) {
        if (signal.aborted) break;
        if ((this.retryNotBefore.get(scopeId) ?? 0) > this.clock.now()) continue;
        const command: CancellationRecoveryCommand = { schemaVersion: 1, scopeId, afterAttemptId: this.cursors.get(scopeId) ?? null };
        let result: CancellationRecoveryPageResult;
        try {
          result = await this.drain(command);
        } catch (error) {
          this.cursors.set(scopeId, null);
          this.retryNotBefore.set(scopeId, this.clock.now() + this.failureBackoffMs);
          await this.observer.onError(command, error);
          continue;
        }
        this.cursors.set(scopeId, result.nextAfterAttemptId);
        if (result.outcomes?.some(value => value.outcome.status === 'unavailable')) {
          this.cursors.set(scopeId, null);
          this.retryNotBefore.set(scopeId, this.clock.now() + this.failureBackoffMs);
        } else this.retryNotBefore.delete(scopeId);
        await this.observer.onPage(command, result);
      }
      if (!signal.aborted) await this.wait(this.pollIntervalMs, signal);
    }
  }
}
