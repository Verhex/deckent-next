import { counterSchema, type AttemptIdentity } from '#domain/index.js';
import type { DispatchRecord, DispatchApplication } from '#engine/core/dispatch/index.js';
import { AuthenticationError } from '#engine/core/authentication/index.js';
import { PolicyAuthorizationError } from '#engine/core/policy/index.js';
import type { RunApplication } from './application.js';
export interface RunCancellationDispatchStore { loadCancellationDispatch(identity: AttemptIdentity): Promise<DispatchRecord | null> }
export type RunCancellationOutcome = Readonly<{ attemptId: string; taskId: string; status: 'not-dispatched' | 'prevented' | 'terminal' | 'unresolved' | 'denied' | 'unavailable' }>;
/** Bounded, repeatable delivery after durable Run intent. Never treats a transport failure as termination. */
export class RunCancellationCoordinator {
  private readonly concurrency: number;
  constructor(private readonly runs: Pick<RunApplication, 'execute'>, private readonly store: RunCancellationDispatchStore,
    private readonly dispatch: Pick<DispatchApplication, 'cancel'>, concurrency: number) {
    this.concurrency = counterSchema.positive().parse(concurrency);
  }
  async cancel(input: unknown, credential?: unknown) {
    const receipt = await this.runs.execute(input, credential);
    const bindings = receipt.snapshot.bindings; const outcomes: RunCancellationOutcome[] = new Array(bindings.length); let cursor = 0;
    const work = async () => {
      while (cursor < bindings.length) {
        const index = cursor++; const identity = bindings[index]!.identity;
        let status: RunCancellationOutcome['status'];
        try {
          const record = await this.store.loadCancellationDispatch(identity);
          if (!record) status = 'not-dispatched';
          else status = (await this.dispatch.cancel(record.request, credential)).kind;
        } catch (error) {
          status = error instanceof AuthenticationError || (error instanceof PolicyAuthorizationError && error.code === 'POLICY_DENIED') ? 'denied' : 'unavailable';
        }
        outcomes[index] = Object.freeze({ attemptId: identity.attemptId, taskId: identity.taskId, status });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, bindings.length) }, work));
    return Object.freeze({ schemaVersion: 1 as const, runId: receipt.snapshot.identity.runId, scopeId: receipt.snapshot.identity.scopeId,
      cancellationRequested: true as const, outcomes: Object.freeze(outcomes) });
  }
}
