import { cancellationDeliveryLimitsSchema, type CancellationDeliveryStore, type CancellationDeliveryLimits, type CancellationDelivery } from './delivery-port.js';
import { counterSchema, type AttemptIdentity } from '#domain/index.js';
import type { DispatchRecord, DispatchApplication } from '#engine/core/dispatch/index.js';
import { AuthenticationError } from '#engine/core/authentication/index.js';
import { PolicyAuthorizationError } from '#engine/core/policy/index.js';
import type { RunApplication } from './application.js';
export interface RunCancellationDispatchStore { loadCancellationDispatch(identity: AttemptIdentity): Promise<DispatchRecord | null> }
export type RunCancellationOutcome = Readonly<{ attemptId: string; taskId: string; delivery?: Readonly<Pick<CancellationDelivery, 'state' | 'attempts' | 'nextEligibleAt'>>; status: 'not-dispatched' | 'prevented' | 'terminal' | 'unresolved' | 'denied' | 'unavailable' }>;
/** Bounded, repeatable delivery after durable Run intent. Never treats a transport failure as termination. */
export class RunCancellationCoordinator {
  private readonly concurrency: number;
  private readonly limits: CancellationDeliveryLimits;
  constructor(private readonly runs: Pick<RunApplication, 'execute'>, private readonly store: RunCancellationDispatchStore & CancellationDeliveryStore,
    private readonly dispatch: Pick<DispatchApplication, 'cancel' | 'authorizeCancellation'>, options: CancellationDeliveryLimits & { readonly maxConcurrentDeliveries: number },
    private readonly runtime: { now(): number; token(): string }) {
    this.concurrency = counterSchema.positive().parse(options.maxConcurrentDeliveries);
    this.limits = cancellationDeliveryLimitsSchema.parse({ maxAttempts: options.maxAttempts, retryDelayMs: options.retryDelayMs, claimTtlMs: options.claimTtlMs });
  }
  async cancel(input: unknown, credential?: unknown) {
    const receipt = await this.runs.execute(input, credential);
    const bindings = receipt.snapshot.bindings; const outcomes: RunCancellationOutcome[] = new Array(bindings.length); let cursor = 0;
    const work = async () => {
      while (cursor < bindings.length) {
        const index = cursor++; const identity = bindings[index]!.identity;
        let status: RunCancellationOutcome['status']; let delivery: RunCancellationOutcome['delivery'];
        try {
          const record = await this.store.loadCancellationDispatch(identity);
          if (!record) status = 'not-dispatched';
          else {
            await this.dispatch.authorizeCancellation(record.request, credential);
            const input = { identity, token: this.runtime.token(), now: this.runtime.now(), limits: this.limits };
            const claimed = await this.store.claimCancellationDelivery(input);
            let persisted = claimed.record;
            if (claimed.acquired) {
              let outcome: 'terminal' | 'prevented' | 'unresolved' | 'denied' | 'unavailable';
              try { outcome = (await this.dispatch.cancel(record.request, credential)).kind; }
              catch (error) { outcome = error instanceof AuthenticationError || (error instanceof PolicyAuthorizationError && error.code === 'POLICY_DENIED') ? 'denied' : 'unavailable'; }
              persisted = await this.store.finishCancellationDelivery({ ...input, now: this.runtime.now(), outcome });
            }
            status = persisted.state === 'terminal' || persisted.state === 'prevented' ? persisted.state : persisted.lastOutcome ?? 'unresolved';
            delivery = Object.freeze({ state: persisted.state, attempts: persisted.attempts, nextEligibleAt: persisted.state === 'claimed' ? persisted.claimUntil : persisted.nextEligibleAt });
          }
        } catch (error) {
          status = error instanceof AuthenticationError || (error instanceof PolicyAuthorizationError && error.code === 'POLICY_DENIED') ? 'denied' : 'unavailable';
        }
        outcomes[index] = Object.freeze({ attemptId: identity.attemptId, taskId: identity.taskId, status, ...(delivery ? { delivery } : {}) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, bindings.length) }, work));
    return Object.freeze({ schemaVersion: 2 as const, runId: receipt.snapshot.identity.runId, scopeId: receipt.snapshot.identity.scopeId,
      cancellationRequested: true as const, outcomes: Object.freeze(outcomes) });
  }
}
