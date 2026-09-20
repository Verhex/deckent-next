import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { ModelInvocationStoreError, type ModelInvocationCancellationRecoveryCommand,
  type ModelInvocationCancellationRecoveryPage } from '#engine/core/model-invocation/index.js';
import { ScopedRuntimeLoop, type ScopedRuntimeLoopClock, type ScopedRuntimeLoopWait } from './scoped-loop.js';

const optionsSchema = z.object({ scopeIds: z.array(identitySchema).min(1),
  pollIntervalMs: z.number().int().positive().safe(), failureBackoffMs: z.number().int().positive().safe() }).strict();
export type ModelCancellationRuntimeLoopOptions = Readonly<z.infer<typeof optionsSchema>>;
export interface ModelCancellationRuntimeObserver {
  onPage(command: ModelInvocationCancellationRecoveryCommand, result: ModelInvocationCancellationRecoveryPage): void | Promise<void>;
  onError(command: ModelInvocationCancellationRecoveryCommand, error: unknown): void | Promise<void>;
}

/** One bounded model-cancellation page per configured scope; no run/attempt cursor is shared. */
export class ModelCancellationRuntimeLoop {
  private readonly loop: ScopedRuntimeLoop<ModelInvocationCancellationRecoveryCommand, ModelInvocationCancellationRecoveryPage>;
  constructor(drain: (command: ModelInvocationCancellationRecoveryCommand) => Promise<ModelInvocationCancellationRecoveryPage>,
    wait: ScopedRuntimeLoopWait, clock: ScopedRuntimeLoopClock, observer: ModelCancellationRuntimeObserver,
    options: ModelCancellationRuntimeLoopOptions) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success || new Set(parsed.data.scopeIds).size !== parsed.data.scopeIds.length) {
      throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    }
    this.loop = new ScopedRuntimeLoop(drain, wait, clock, observer,
      { ...parsed.data, scopeIds: Object.freeze([...parsed.data.scopeIds]) }, {
        command: (scopeId, afterInvocationId) => ({ schemaVersion: 1, scopeId, afterInvocationId }),
        nextCursor: result => result.nextAfterInvocationId,
        // An individual unavailable controller must not starve later durable requests.
        unavailable: () => false,
      }, () => new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE'));
  }
  run(signal: AbortSignal): Promise<void> { return this.loop.run(signal); }
}
