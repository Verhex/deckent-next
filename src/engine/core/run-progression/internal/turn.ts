import { z } from 'zod';
import { runSnapshotSchema, type AttemptIdentity, type RunSnapshot } from '#domain/index.js';
import { runQuerySchema, projectRunView, RunStoreError, type RunQuery, type RunReservationCommand } from '#engine/core/runs/index.js';
import type { TaskEvaluationCommand } from '#engine/core/task-evaluation/index.js';

/** Trusted, freshly authorized application operations. This port grants no execution permission. */
export interface RunProgressionOperations {
  read(query: RunQuery): Promise<RunSnapshot>;
  reserve(command: RunReservationCommand): Promise<'reserved' | 'waiting' | 'changed'>;
  execute(identity: AttemptIdentity): Promise<void>;
  evaluate(command: TaskEvaluationCommand): Promise<'recorded' | 'changed'>;
  evaluationRecorded(identity: AttemptIdentity, revision: number): Promise<boolean>;
}
export interface RunProgressionRuntime { commandId(): string }
const concurrencySchema = z.number().int().positive().safe();

/** One finite, completion-driven advancement turn. Scheduler, launch and acceptance remain with existing owners.
 * No automatic retries, background intent or new Run state. A host must explicitly admit each turn.
 */
export class RunProgressionTurn {
  private readonly concurrency: number;
  private readonly maxReservations: number | undefined;
  constructor(private readonly operations: RunProgressionOperations, concurrency: number,
    private readonly runtime: RunProgressionRuntime, maxReservations?: number) {
    this.concurrency = concurrencySchema.parse(concurrency);
    this.maxReservations = maxReservations === undefined ? undefined : concurrencySchema.parse(maxReservations);
  }
  private async read(query: RunQuery) {
    const run = runSnapshotSchema.parse(await this.operations.read(query));
    if (run.identity.scopeId !== query.scopeId || run.identity.runId !== query.runId) throw new RunStoreError('RUN_STORE_CORRUPT');
    return run;
  }
  private async evaluateReady(query: RunQuery, signal: AbortSignal) {
    const initial = await this.read(query);
    for (const binding of initial.bindings) {
      if (signal.aborted) return;
      const latest = await this.read(query);
      if (latest.cancelRequested) return;
      const progress = latest.progress.find(task => task.taskId === binding.identity.taskId);
      const current = latest.bindings.find(value => value.identity.attemptId === binding.identity.attemptId);
      if (progress?.phase !== 'evaluating' || progress.unresolvedEffects || current?.observedKind !== 'exited'
        || current.observedRevision === null || !current) continue;
      if (await this.operations.evaluationRecorded(current.identity, current.observedRevision)) continue;
      await this.operations.evaluate({ schemaVersion: 1, commandId: this.runtime.commandId(), identity: current.identity, expectedRevision: latest.revision });
    }
  }
  async advance(input: unknown, signal: AbortSignal) {
    const query = runQuerySchema.parse(input);
    const started = new Set<string>();
    type Completion = { attemptId: string; ok: true } | { attemptId: string; ok: false; error: unknown };
    const running = new Map<string, Promise<Completion>>();
    let attempted = 0, reservations = 0;
    let failure: { error: unknown } | undefined;
    const throwIfFailed = () => { if (failure) throw failure.error; };
    const startReserved = (run: RunSnapshot) => {
      for (const binding of run.bindings) {
        if (failure || signal.aborted || running.size >= this.concurrency) break;
        const identity = binding.identity;
        const task = run.progress.find(value => value.taskId === identity.taskId);
        if (started.has(identity.attemptId) || task?.phase !== 'active' || task.unresolvedEffects) continue;
        started.add(identity.attemptId); attempted++;
        // Capture failures immediately. Every admitted execution is drained before returning, even on error.
        const work = Promise.resolve().then(async () => {
          if (!failure && !signal.aborted) await this.operations.execute(identity);
        }).then(
          (): Completion => ({ attemptId: identity.attemptId, ok: true }),
          (error: unknown): Completion => {
            failure ??= { error }; return { attemptId: identity.attemptId, ok: false, error };
          });
        running.set(identity.attemptId, work);
      }
    };
    try {
      while (!signal.aborted) {
        throwIfFailed();
        let run = await this.read(query);
        throwIfFailed();
        if (run.cancelRequested) break;
        // One serial acceptance pass per completion; concurrently finishing workers may change revision.
        // A typed changed outcome is deferred, never retried in a tight loop.
        await this.evaluateReady(query, signal);
        run = await this.read(query);
        throwIfFailed();
        if (signal.aborted || run.cancelRequested) break;
        startReserved(run);
        // Cooperative yield: stop taking new reservations, but drain existing custody before returning.
        if ((this.maxReservations === undefined || reservations < this.maxReservations)
          && running.size < this.concurrency && run.progress.some(task => task.phase === 'pending')) {
          reservations++;
          await this.operations.reserve({ ...query, commandId: this.runtime.commandId(), expectedRevision: run.revision });
          run = await this.read(query);
          if (!run.cancelRequested) startReserved(run);
        }
        if (!running.size) break;
        const completed = await Promise.race(running.values());
        running.delete(completed.attemptId);
        if (!completed.ok) throw completed.error;
        // Re-enter immediately: acceptance releases capacity before unrelated workers finish.
      }
    } finally { await Promise.allSettled(running.values()); }
    throwIfFailed();
    const final = await this.read(query);
    return Object.freeze({ run: projectRunView(final), stopped: signal.aborted || final.cancelRequested, attempted });
  }
}
