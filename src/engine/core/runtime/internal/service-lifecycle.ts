import { z } from 'zod';

const positiveSafeInteger = z.number().int().positive().safe();
export interface RuntimeServiceDeadline { wait(milliseconds: number, signal: AbortSignal): Promise<void> }
export interface RuntimeServiceLifecycleOptions { readonly maxConcurrentRequests: number; readonly maxConcurrentExecutions: number }
export type RuntimeServiceWorkClass = 'execution' | 'control';
export type RuntimeServiceDrainResult = Readonly<{ state: 'clean' | 'incomplete'; remainingRequests: number; recoveryPending: boolean }>;
export class RuntimeServiceLifecycleError extends Error {
  constructor(readonly code: 'RUNTIME_SERVICE_OPTIONS' | 'RUNTIME_SERVICE_BUSY' | 'RUNTIME_SERVICE_STOPPING' | 'RUNTIME_SERVICE_RECOVERY_FAILED' | 'RUNTIME_SERVICE_NOT_STOPPING') { super(code); this.name = 'RuntimeServiceLifecycleError'; }
}

/** Transport-neutral admission and graceful recovery-loop shutdown. It never cancels worker operations. */
export class RuntimeServiceLifecycle {
  private readonly maxConcurrentRequests: number;
  private readonly maxConcurrentExecutions: number;
  private executions = 0;
  private readonly active = new Set<Promise<void>>();
  private accepting = true;
  private stopping: Promise<RuntimeServiceDrainResult> | null = null;
  private settled: Promise<void> | null = null;
  constructor(options: RuntimeServiceLifecycleOptions, private readonly stopRecovery: () => void | Promise<void>, private readonly deadline: RuntimeServiceDeadline) {
    try {
      this.maxConcurrentRequests = positiveSafeInteger.parse(options.maxConcurrentRequests);
      this.maxConcurrentExecutions = positiveSafeInteger.parse(options.maxConcurrentExecutions);
      if (this.maxConcurrentExecutions >= this.maxConcurrentRequests) throw new Error('invalid');
    } catch { throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_OPTIONS'); }
    if (typeof stopRecovery !== 'function' || !deadline || typeof deadline.wait !== 'function') throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_OPTIONS');
  }
  admit<T>(operation: () => Promise<T> | T, workClass: RuntimeServiceWorkClass = 'control'): Promise<T> {
    if (!this.accepting) throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_STOPPING');
    if (this.active.size >= this.maxConcurrentRequests || (workClass === 'execution' && this.executions >= this.maxConcurrentExecutions)) throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_BUSY');
    if (workClass === 'execution') this.executions++;
    const result = Promise.resolve().then(operation);
    const tracked = result.then(() => undefined, () => undefined).finally(() => { this.active.delete(tracked); if (workClass === 'execution') this.executions--; });
    this.active.add(tracked);
    return result;
  }
  stop(graceMilliseconds: number): Promise<RuntimeServiceDrainResult> {
    if (this.stopping) return this.stopping;
    try { positiveSafeInteger.parse(graceMilliseconds); }
    catch { throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_OPTIONS'); }
    this.accepting = false;
    const recovery = Promise.resolve().then(this.stopRecovery).catch(() => { throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_RECOVERY_FAILED'); });
    const operations = [...this.active];
    this.settled = Promise.allSettled([...operations, recovery]).then(outcomes => {
      const recoveryOutcome = outcomes.at(-1)!;
      if (recoveryOutcome.status === 'rejected') throw recoveryOutcome.reason;
    });
    // Retaining a rejecting completion promise must not require every stop() caller to also observe whenSettled().
    // This consumes only the derived branch; whenSettled() preserves the original rejection for lifecycle owners.
    void this.settled.catch(() => undefined);
    const work = this.drain(graceMilliseconds, operations, recovery); this.stopping = work;
    return work;
  }
  whenSettled(): Promise<void> {
    if (!this.settled) throw new RuntimeServiceLifecycleError('RUNTIME_SERVICE_NOT_STOPPING');
    return this.settled;
  }
  private async drain(graceMilliseconds: number, operations: readonly Promise<void>[], recovery: Promise<void>): Promise<RuntimeServiceDrainResult> {
    let recoveryPending = true;
    const completed = Promise.all([...operations, recovery.then(() => { recoveryPending = false; })]);
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
    return Object.freeze({ state: 'incomplete' as const, remainingRequests: this.active.size, recoveryPending });
  }
}
