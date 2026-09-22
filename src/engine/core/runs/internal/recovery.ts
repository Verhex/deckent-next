import { z } from 'zod';
import { counterSchema, identitySchema, type AttemptIdentity } from '#domain/index.js';
import { authenticate, AuthenticationError, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { PolicyAuthorizationError } from '#engine/core/policy/index.js';
import type { DispatchApplication, DispatchInventoryAuthorization } from '#engine/core/dispatch/index.js';
import type { RunAuthorization } from './application.js';
import { CancellationDeliveryWorker } from './delivery-worker.js';
import { CancellationDeliveryError, type CancellationDeliveryLimits, type CancellationDeliveryStore } from './delivery-port.js';
import type { RunCancellationDispatchStore, RunCancellationOutcome } from './cancellation.js';
import type { RunCancellationSettlementStore } from './settlement.js';
import { cancellationRecoveryPageSchema, type CancellationRecoveryQueryStore } from './recovery-query.js';

export const cancellationRecoveryCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  afterAttemptId: identitySchema.nullable() }).strict();
export type CancellationRecoveryCommand = z.infer<typeof cancellationRecoveryCommandSchema>;
export const cancellationRecoveryFailureReasonSchema = z.enum(['AUTHENTICATION_REQUIRED', 'AUTHENTICATION_SCOPE_DENIED',
  'POLICY_DENIED', 'POLICY_UNAVAILABLE', 'CANCELLATION_DELIVERY_CONFLICT', 'CANCELLATION_DELIVERY_CORRUPT', 'UNKNOWN']);
export type CancellationRecoveryFailureReason = z.infer<typeof cancellationRecoveryFailureReasonSchema>;
export type CancellationRecoveryOutcome = Readonly<{ identity: AttemptIdentity; outcome: RunCancellationOutcome; reason?: CancellationRecoveryFailureReason }>;

function failureReason(error: unknown): CancellationRecoveryFailureReason {
  if (error instanceof AuthenticationError) return cancellationRecoveryFailureReasonSchema.parse(error.code);
  if (error instanceof PolicyAuthorizationError) return cancellationRecoveryFailureReasonSchema.parse(error.code);
  if (error instanceof CancellationDeliveryError) return cancellationRecoveryFailureReasonSchema.parse(error.code);
  return 'UNKNOWN';
}

/** A bounded recovery page consumes durable intent, never creates a new cancellation command.
 * Lifecycle hosting is separate. Stopping a host must await its in-flight page.
 */
export class CancellationRecoveryApplication {
  private readonly pageSize: number;
  private readonly concurrency: number;
  private readonly worker: CancellationDeliveryWorker;
  constructor(private readonly store: CancellationRecoveryQueryStore & RunCancellationDispatchStore & CancellationDeliveryStore & Partial<RunCancellationSettlementStore>,
    private readonly verifier: PrincipalVerifier, private readonly scopeAuthorization: DispatchInventoryAuthorization,
    private readonly runAuthorization: RunAuthorization, dispatch: Pick<DispatchApplication, 'cancel' | 'authorizeCancellation'>,
    options: CancellationDeliveryLimits & { maxPageSize: number; maxConcurrentDeliveries: number },
    private readonly runtime: { now(): number; token(): string }) {
    this.pageSize = counterSchema.positive().parse(options.maxPageSize);
    this.concurrency = counterSchema.positive().parse(options.maxConcurrentDeliveries);
    this.worker = new CancellationDeliveryWorker(store, dispatch, { maxAttempts: options.maxAttempts,
      retryDelayMs: options.retryDelayMs, claimTtlMs: options.claimTtlMs }, runtime);
  }
  async drain(input: unknown, credential?: unknown) {
    const command = cancellationRecoveryCommandSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    await this.scopeAuthorization.authorize(command.scopeId, principal);
    const result = await this.store.discoverCancellationRecovery({ scopeId: command.scopeId,
      afterAttemptId: command.afterAttemptId, limit: this.pageSize, now: counterSchema.parse(this.runtime.now()) });
    let page;
    try {
      page = cancellationRecoveryPageSchema.parse(result);
      if (page.identities.length > this.pageSize || page.identities.some(identity => identity.scopeId !== command.scopeId)
        || new Set(page.identities.map(identity => identity.attemptId)).size !== page.identities.length) {
        throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT');
      }
    } catch { throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT'); }
    const outcomes: CancellationRecoveryOutcome[] = new Array(page.identities.length); let cursor = 0;
    const work = async () => {
      while (cursor < page.identities.length) {
        const index = cursor++; const identity = page.identities[index]!;
        let outcome: RunCancellationOutcome; let reason: CancellationRecoveryFailureReason | undefined;
        try {
          const current = await authenticate(this.verifier, credential, command.scopeId);
          await this.scopeAuthorization.authorize(command.scopeId, current);
          await this.runAuthorization.authorize('cancel', { schemaVersion: 1, scopeId: identity.scopeId, runId: identity.runId }, current);
          outcome = await this.worker.deliver(identity, credential, error => { reason = failureReason(error); });
        } catch (error) {
          outcome = { attemptId: identity.attemptId, taskId: identity.taskId,
            status: error instanceof AuthenticationError || (error instanceof PolicyAuthorizationError && error.code === 'POLICY_DENIED') ? 'denied' : 'unavailable' };
          outcomes[index] = Object.freeze({ identity, outcome, reason: failureReason(error) });
          continue;
        }
        outcomes[index] = Object.freeze({ identity, outcome, ...(reason ? { reason } : {}) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, page.identities.length) }, work));
    return Object.freeze({ schemaVersion: 1 as const, scopeId: command.scopeId, nextAfterAttemptId: page.nextAfterAttemptId,
      outcomes: Object.freeze(outcomes) });
  }
}
