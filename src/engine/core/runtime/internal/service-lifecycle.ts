import { AsyncResource } from 'node:async_hooks';
import { z } from 'zod';

const positiveSafeInteger = z.number().int().positive().safe();
export interface RuntimeServiceDeadline { wait(milliseconds: number, signal: AbortSignal): Promise<void> }
/** `admissionWaitMs` bounds how long a transport request may wait for capacity before the typed refusal (0 or absent: refuse at once);
 * the wait queue never holds more than `maxConcurrentRequests` requests. */
export interface RuntimeServiceLifecycleOptions { readonly maxConcurrentRequests: number; readonly maxConcurrentExecutions: number; readonly admissionWaitMs?: number }
export type RuntimeServiceWorkClass = 'execution' | 'control';
export type RuntimeServiceDrainResult = Readonly<{ state: 'clean' | 'incomplete'; remainingRequests: number; recoveryPending: boolean }>;
export class RuntimeServiceLifecycleError extends Error {
  /** Set on a refusal after a bounded wait: when the caller may reasonably try again. */
  constructor(readonly code: 'RUNTIME_SERVICE_OPTIONS' | 'RUNTIME_SERVICE_BUSY' | 'RUNTIME_SERVICE_STOPPING' | 'RUNTIME_SERVICE_RECOVERY_FAILED' | 'RUNTIME_SERVICE_NOT_STOPPING',
    readonly retryAfterMs?: number) { super(code); this.name = 'RuntimeServiceLifecycleError'; }
}

/** Transport-neutral admission and graceful recovery-loop shutdown. It never cancels worker operations. */
export class RuntimeServiceLifecycle {
  private readonly maxConcurrentRequests: number;
  private readonly maxConcurrentExecutions: number;
  private requests = 0;
  private executions = 0;
  private readonly executionWaiters: (() => void)[] = [];
  private readonly admissionWaitMs: number;
  private readonly admissionQueue: { workClass: RuntimeServiceWorkClass; start: () => void; reject: (error: unknown) => void }[] = [];
  private readonly active = new Set<Promise<void>>();
  private accepting = true;
  private stopping: Promise<RuntimeServiceDrainResult> | null = null;
  private settled: Promise<void> | null = null;
  constructor(options: RuntimeServiceLifecycleOptions, private readonly stopRecovery: () => void | Promise<void>, private readonly deadline: RuntimeServiceDeadline) {
    try {
      this.maxConcurrentRequests = positiveSafeInteger.parse(options.maxConcurrentRequests);
      this.maxConcurrentExecutions = positiveSafeInteger.parse(options.maxConcurrentExecutions);
      if (this.maxConcurrentExecutions >= this.maxConcurrentRequests) throw new Error('invalid');
      this.admissionWaitMs = options.admissionWaitMs === undefined ? 0 : z.number().int().nonnegative().safe().parse(options.admissionWaitMs);
    } catch { throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_OPTIONS'); }
    if (typeof stopRecovery !== 'function' || !deadline || typeof deadline.wait !== 'function') throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_OPTIONS');
  }
  private fits(workClass: RuntimeServiceWorkClass): boolean {
    return this.requests < this.maxConcurrentRequests && (workClass !== 'execution' || this.executions < this.maxConcurrentExecutions);
  }
  admit<T>(operation: () => Promise<T> | T, workClass: RuntimeServiceWorkClass = 'control'): Promise<T> {
    if (!this.accepting) throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_STOPPING');
    if (!this.fits(workClass)) throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_BUSY');
    return this.start(operation, workClass);
  }
  /** Transport admission with a bounded wait: a request that does not fit waits at most `admissionWaitMs` (FIFO, bounded queue) and is then
   * refused with the typed BUSY carrying `retryAfterMs`. Without a configured wait it is `admit`. Never waits unboundedly. */
  async admitBounded<T>(operation: () => Promise<T> | T, workClass: RuntimeServiceWorkClass = 'control'): Promise<T> {
    if (!this.accepting) throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_STOPPING');
    if (this.fits(workClass) && !this.admissionQueue.some(waiting => waiting.workClass === workClass)) return this.start(operation, workClass);
    if (this.admissionWaitMs === 0 || this.admissionQueue.length >= this.maxConcurrentRequests) throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_BUSY', this.admissionWaitMs || undefined);
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      // The slot is reserved by `pump`; the operation starts in the same turn, so a stop cannot fall between reservation and tracking.
      // The operation keeps the async context it was admitted in (P0 batch C): `pump` runs from another request's completion, whose
      // context (e.g. its local-principal channel, owner vs MCP actor) must never become the waiter's.
      const admitted = AsyncResource.bind(operation);
      const entry = { workClass, start: () => { controller.abort(); resolve(this.startAdmitted(admitted, workClass)); }, reject: (error: unknown) => { controller.abort(); reject(error); } };
      this.admissionQueue.push(entry);
      const expire = (failure: unknown) => {
        const index = this.admissionQueue.indexOf(entry);
        if (index >= 0) { this.admissionQueue.splice(index, 1); reject(failure); }
      };
      Promise.resolve().then(() => this.deadline.wait(this.admissionWaitMs, controller.signal))
        .then(() => expire(new RuntimeServiceLifecycleError('RUNTIME_SERVICE_BUSY', this.admissionWaitMs)), expire);
    });
  }
  /** Hands freed capacity to waiting requests in arrival order; a waiter that still does not fit never blocks one that does. */
  private pump(): void {
    for (let index = 0; index < this.admissionQueue.length;) {
      const entry = this.admissionQueue[index]!;
      if (!this.fits(entry.workClass)) { index++; continue; }
      this.admissionQueue.splice(index, 1);
      // The slot is taken here, synchronously: a later arrival cannot overtake the waiter.
      this.requests++; if (entry.workClass === 'execution') this.executions++;
      entry.start();
    }
  }
  private startAdmitted<T>(operation: () => Promise<T> | T, workClass: RuntimeServiceWorkClass): Promise<T> {
    const result = Promise.resolve().then(operation);
    return this.track(result, true, workClass === 'execution');
  }
  private start<T>(operation: () => Promise<T> | T, workClass: RuntimeServiceWorkClass): Promise<T> {
    this.requests++;
    if (workClass === 'execution') this.executions++;
    const result = Promise.resolve().then(operation);
    return this.track(result, true, workClass === 'execution');
  }
  /** Internal Run turns are bounded by the runtime's Run/attempt concurrency. Reserved attempts wait for
   * a shared execution slot; transport requests retain their independent refusal/capacity contract. */
  admitExecution<T>(operation: () => Promise<T> | T, onSlotWait?: (waitedForSlotMs: number) => void): Promise<T> {
    if (!this.accepting) throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_STOPPING');
    let slot: Promise<void> | undefined;
    if (this.executions < this.maxConcurrentExecutions) this.executions++;
    else slot = new Promise<void>(resolve => { this.executionWaiters.push(resolve); });
    const waitingSince = slot ? performance.now() : undefined;
    const result = slot ? slot.then(() => { onSlotWait?.(performance.now() - waitingSince!); return operation(); }) : Promise.resolve().then(operation);
    return this.track(result, false, true);
  }
  private track<T>(result: Promise<T>, request: boolean, execution: boolean): Promise<T> {
    const tracked = result.then(() => undefined, () => undefined).finally(() => {
      this.active.delete(tracked);
      if (request) this.requests--;
      if (execution) {
        const next = this.executionWaiters.shift();
        // Transfer the occupied slot directly: a new admission cannot bypass an existing waiter.
        if (next) next(); else this.executions--;
      }
      this.pump();
    });
    this.active.add(tracked);
    return result;
  }
  stop(graceMilliseconds: number, finalize: () => void | Promise<void> = () => undefined): Promise<RuntimeServiceDrainResult> {
    if (this.stopping) return this.stopping;
    try { positiveSafeInteger.parse(graceMilliseconds); }
    catch { throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_OPTIONS'); }
    this.accepting = false;
    for (const waiting of this.admissionQueue.splice(0)) waiting.reject(new RuntimeServiceLifecycleError('RUNTIME_SERVICE_STOPPING'));
    let recoveryPending = true;
    const recovery = Promise.resolve().then(this.stopRecovery).then(() => { recoveryPending = false; }, () => {
      recoveryPending = false; throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_RECOVERY_FAILED');
    });
    const operations = [...this.active];
    this.settled = Promise.allSettled([...operations, recovery]).then(async outcomes => {
      await finalize();
      const recoveryOutcome = outcomes.at(-1)!;
      if (recoveryOutcome.status === 'rejected') throw recoveryOutcome.reason;
    });
    // Retaining a rejecting completion promise must not require every stop() caller to also observe whenSettled().
    // This consumes only the derived branch; whenSettled() preserves the original rejection for lifecycle owners.
    void this.settled.catch(() => undefined);
    const work = this.drain(graceMilliseconds, this.settled, () => recoveryPending); this.stopping = work;
    return work;
  }
  whenSettled(): Promise<void> {
    if (!this.settled) throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_NOT_STOPPING');
    return this.settled;
  }
  private async drain(graceMilliseconds: number, completed: Promise<void>, isRecoveryPending: () => boolean): Promise<RuntimeServiceDrainResult> {
    const controller = new AbortController();
    const elapsed = Promise.resolve().then(() => this.deadline.wait(graceMilliseconds, controller.signal));
    // Deadline failures are lifecycle failures; only the losing clean-completion deadline is consumed.
    let winner: 'clean' | 'incomplete';
    try {
      winner = await Promise.race([completed.then(() => 'clean' as const), elapsed.then(() => 'incomplete' as const)]);
    } catch (error) {
      controller.abort(); void elapsed.catch(() => undefined); throw error;
    }
    if (winner === 'clean') {
      controller.abort();
      void elapsed.catch(() => undefined);
      return Object.freeze({ state: 'clean' as const, remainingRequests: 0, recoveryPending: false });
    }
    return Object.freeze({ state: 'incomplete' as const, remainingRequests: this.active.size, recoveryPending: isRecoveryPending() });
  }
}
