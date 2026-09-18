import type { AttemptIdentity } from '#domain/index.js';
import type { DispatchApplication } from '#engine/core/dispatch/index.js';
import { AuthenticationError } from '#engine/core/authentication/index.js';
import { PolicyAuthorizationError } from '#engine/core/policy/index.js';
import { cancellationDeliveryLimitsSchema, type CancellationDeliveryStore, type CancellationDeliveryLimits } from './delivery-port.js';
import type { RunCancellationDispatchStore, RunCancellationOutcome } from './cancellation.js';

/** One delivery authority shared by explicit commands and restart recovery. */
export class CancellationDeliveryWorker {
  private readonly limits: CancellationDeliveryLimits;
  constructor(private readonly store: RunCancellationDispatchStore & CancellationDeliveryStore,
    private readonly dispatch: Pick<DispatchApplication, 'cancel' | 'authorizeCancellation'>,
    limits: CancellationDeliveryLimits, private readonly runtime: { now(): number; token(): string }) {
    this.limits = cancellationDeliveryLimitsSchema.parse(limits);
  }
  async deliver(identity: AttemptIdentity, credential?: unknown): Promise<RunCancellationOutcome> {
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
    return Object.freeze({ attemptId: identity.attemptId, taskId: identity.taskId, status, ...(delivery ? { delivery } : {}) });
  }
}
