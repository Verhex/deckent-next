import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import type { CancellationRecoveryCommand } from '#engine/core/runs/index.js';
import { ScopedRuntimeLoop } from './scoped-loop.js';

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
  private readonly loop: ScopedRuntimeLoop<CancellationRecoveryCommand, CancellationRecoveryPageResult>;
  constructor(drain: CancellationRecoveryDrain, wait: CancellationRuntimeWait,
    clock: CancellationRuntimeClock, observer: CancellationRuntimeLoopObserver, options: CancellationRuntimeLoopOptions) {
    let parsed;
    try { parsed = loopOptionsSchema.parse(options); }
    catch { throw new CancellationRuntimeLoopError('CANCELLATION_RUNTIME_LOOP_OPTIONS'); }
    if (new Set(parsed.scopeIds).size !== parsed.scopeIds.length) throw new CancellationRuntimeLoopError('CANCELLATION_RUNTIME_LOOP_OPTIONS');
    const loopOptions = { ...parsed, scopeIds: Object.freeze([...parsed.scopeIds]) };
    this.loop = new ScopedRuntimeLoop(drain, wait, clock, observer, loopOptions, {
      command: (scopeId, afterAttemptId) => ({ schemaVersion: 1, scopeId, afterAttemptId }),
      nextCursor: result => result.nextAfterAttemptId,
      // Individual delivery failures remain visible; they must not starve later pages.
      // Page/transport failures throw and retain the shared loop's scope backoff.
      unavailable: () => false,
    }, () => new CancellationRuntimeLoopError('CANCELLATION_RUNTIME_LOOP_RUNNING'));
  }
  run(signal: AbortSignal): Promise<void> { return this.loop.run(signal); }
}
