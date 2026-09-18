import { CancellationDeliveryWorker } from './delivery-worker.js';
import { type CancellationDeliveryStore, type CancellationDeliveryLimits, type CancellationDelivery } from './delivery-port.js';
import { counterSchema, type AttemptIdentity } from '#domain/index.js';
import type { DispatchRecord, DispatchApplication } from '#engine/core/dispatch/index.js';
import type { RunApplication } from './application.js';
export interface RunCancellationDispatchStore { loadCancellationDispatch(identity: AttemptIdentity): Promise<DispatchRecord | null> }
export type RunCancellationOutcome = Readonly<{ attemptId: string; taskId: string; delivery?: Readonly<Pick<CancellationDelivery, 'state' | 'attempts' | 'nextEligibleAt'>>; status: 'not-dispatched' | 'prevented' | 'terminal' | 'unresolved' | 'denied' | 'unavailable' }>;
/** Bounded, repeatable delivery after durable Run intent. Never treats a transport failure as termination. */
export class RunCancellationCoordinator {
  private readonly concurrency: number;
  private readonly worker: CancellationDeliveryWorker;
  constructor(private readonly runs: Pick<RunApplication, 'execute'>, store: RunCancellationDispatchStore & CancellationDeliveryStore,
    dispatch: Pick<DispatchApplication, 'cancel' | 'authorizeCancellation'>, options: CancellationDeliveryLimits & { readonly maxConcurrentDeliveries: number },
    runtime: { now(): number; token(): string }) {
    this.concurrency = counterSchema.positive().parse(options.maxConcurrentDeliveries);
    this.worker = new CancellationDeliveryWorker(store, dispatch, { maxAttempts: options.maxAttempts, retryDelayMs: options.retryDelayMs, claimTtlMs: options.claimTtlMs }, runtime);
  }
  async cancel(input: unknown, credential?: unknown) {
    const receipt = await this.runs.execute(input, credential);
    const bindings = receipt.snapshot.bindings; const outcomes: RunCancellationOutcome[] = new Array(bindings.length); let cursor = 0;
    const work = async () => {
      while (cursor < bindings.length) {
        const index = cursor++; const identity = bindings[index]!.identity;
        outcomes[index] = await this.worker.deliver(identity, credential);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, bindings.length) }, work));
    return Object.freeze({ schemaVersion: 2 as const, runId: receipt.snapshot.identity.runId, scopeId: receipt.snapshot.identity.scopeId,
      cancellationRequested: true as const, outcomes: Object.freeze(outcomes) });
  }
}
