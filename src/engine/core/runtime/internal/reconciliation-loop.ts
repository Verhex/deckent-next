import { CodedError } from '#platform/index.js';
import { persistedInteger, identitySchema } from '#domain/index.js';
import { z } from 'zod';
import type { ReconciliationRecoveryCommand, ReconciliationRecoveryPage } from './reconciliation-recovery.js';
import { ScopedRuntimeLoop, type ScopedRuntimeLoopClock, type ScopedRuntimeLoopWait } from './scoped-loop.js';

const optionsSchema = z.strictObject({ scopeIds: z.array(identitySchema).min(1), pollIntervalMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  failureBackoffMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) });
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type ReconciliationRuntimeLoopOptions = Readonly<z.infer<typeof optionsSchema>>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type ReconciliationRecoveryDrain = (command: ReconciliationRecoveryCommand) => Promise<ReconciliationRecoveryPage>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export interface ReconciliationRuntimeLoopObserver {
  onPage(command: ReconciliationRecoveryCommand, result: ReconciliationRecoveryPage): void | Promise<void>;
  onError(command: ReconciliationRecoveryCommand, error: unknown): void | Promise<void>;
}
export class ReconciliationRuntimeLoopError extends CodedError {
  constructor(override readonly code: 'RECONCILIATION_RUNTIME_LOOP_OPTIONS' | 'RECONCILIATION_RUNTIME_LOOP_RUNNING') {
    super(code); this.name = 'ReconciliationRuntimeLoopError';
  }
}

/** Runtime-neutral wrapper for bounded reconciliation recovery pages. */
export class ReconciliationRuntimeLoop {
  private readonly loop: ScopedRuntimeLoop<ReconciliationRecoveryCommand, ReconciliationRecoveryPage>;
  constructor(drain: ReconciliationRecoveryDrain, wait: ScopedRuntimeLoopWait, clock: ScopedRuntimeLoopClock,
    observer: ReconciliationRuntimeLoopObserver, options: ReconciliationRuntimeLoopOptions) {
    let parsed;
    try { parsed = optionsSchema.parse(options); }
    catch { throw new ReconciliationRuntimeLoopError('RECONCILIATION_RUNTIME_LOOP_OPTIONS'); }
    if (new Set(parsed.scopeIds).size !== parsed.scopeIds.length) {
      throw new ReconciliationRuntimeLoopError('RECONCILIATION_RUNTIME_LOOP_OPTIONS');
    }
    const loopOptions = { ...parsed, scopeIds: Object.freeze([...parsed.scopeIds]) };
    this.loop = new ScopedRuntimeLoop(drain, wait, clock, observer, loopOptions, {
      command: (scopeId, after) => ({ schemaVersion: 1, scopeId, after }),
      nextCursor: result => result.nextAfter,
      // A validated page remains traversable when an individual recovery fails.
      // Page/transport failures throw and are backed off by ScopedRuntimeLoop.
      unavailable: () => false,
    }, () => new ReconciliationRuntimeLoopError('RECONCILIATION_RUNTIME_LOOP_RUNNING'));
  }
  run(signal: AbortSignal): Promise<void> { return this.loop.run(signal); }
}
