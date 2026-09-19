import { z } from 'zod';
import { counterSchema, identitySchema, runSnapshotSchema, sameAttemptIdentity } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { PoolAuthorization } from '#engine/core/policy/index.js';
import { diagnoseReservationWave, planSchedulingWave } from '#engine/core/scheduling/index.js';
import { runQuerySchema, type RunAuthorization } from './application.js';
import { runExecutionPolicySchema, runReservationSchema, RunStoreError, type RunStore, type RunReceipt, type RunReservation } from './store.js';
import { assertRunExecution } from './registry.js';
import { projectRunView } from './view.js';

export const runReservationCommandSchema = runQuerySchema.extend({ commandId: identitySchema, expectedRevision: counterSchema }).strict();
export type RunReservationCommand = z.infer<typeof runReservationCommandSchema>;
export interface RunReservationStore extends Pick<RunStore, 'loadRun' | 'loadRunReceipt' | 'reserveRunTasks'> {
  loadRunExecutionPolicy(scopeId: string, runId: string): Promise<z.infer<typeof runExecutionPolicySchema>>;
}
export interface ReservationRuntime { now(): number; attemptId(): string }
const recordedReservation = runReservationSchema.extend({ action: z.literal('reserve-run-tasks') }).strict();
function checkedSnapshot(input: unknown) {
  try { const run = runSnapshotSchema.parse(input); assertRunExecution(run.graph, run.execution); return run; }
  catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
}

/** Public reservation selects a bounded scheduler wave; callers cannot mint identities, choose
 * tasks, supply capacity or override time. The ledger remains the atomic shared-pool authority.
 */
export class RunReservationApplication {
  constructor(private readonly store: RunReservationStore, private readonly verifier: PrincipalVerifier,
    private readonly authorization: RunAuthorization, private readonly poolAuthorization: PoolAuthorization, private readonly runtime: ReservationRuntime) {}
  private project(receipt: RunReceipt, command: RunReservationCommand, actor: RunReservation['actor']) {
    let recorded;
    try { recorded = recordedReservation.parse(JSON.parse(receipt.command)); }
    catch { throw new RunStoreError('RUN_COMMAND_CONFLICT'); }
    if (recorded.commandId !== command.commandId || recorded.scopeId !== command.scopeId || recorded.runId !== command.runId
      || recorded.expectedRevision !== command.expectedRevision || JSON.stringify(recorded.actor) !== JSON.stringify(actor)) {
      throw new RunStoreError('RUN_COMMAND_CONFLICT');
    }
    const run = checkedSnapshot(receipt.snapshot);
    if (receipt.commandId !== command.commandId || run.cancelRequested || run.identity.scopeId !== command.scopeId || run.identity.runId !== command.runId
      || run.revision !== command.expectedRevision + 1 || new Set(recorded.identities.map(identity => identity.taskId)).size !== recorded.identities.length
      || recorded.identities.some(identity => !run.bindings.some(binding => sameAttemptIdentity(binding.identity, identity)
        && binding.observedRevision === null && binding.observedKind === null)
        || !run.progress.some(task => task.taskId === identity.taskId && task.phase === 'active'))) {
      throw new RunStoreError('RUN_STORE_CORRUPT');
    }
    return Object.freeze({ schemaVersion: 1 as const, commandId: command.commandId,
      run: projectRunView(run), identities: Object.freeze(recorded.identities) });
  }
  async reserve(input: unknown, credential?: unknown) {
    const command = runReservationCommandSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    await this.authorization.authorize('reserve', command, principal);
    const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    const existing = await this.store.loadRunReceipt(command.scopeId, command.commandId);
    if (existing) return this.project(existing, command, actor);
    try {
      const inputRun = await this.store.loadRun(command.scopeId, command.runId);
      if (!inputRun) throw new RunStoreError('RUN_STORE_CONFLICT');
      const run = checkedSnapshot(inputRun);
      if (run.identity.scopeId !== command.scopeId || run.identity.runId !== command.runId || run.revision !== command.expectedRevision || run.cancelRequested) {
        throw new RunStoreError('RUN_STORE_CONFLICT');
      }
      const policy = runExecutionPolicySchema.parse(await this.store.loadRunExecutionPolicy(command.scopeId, command.runId));
      const now = counterSchema.parse(this.runtime.now());
      const wave = planSchedulingWave(run.graph, { schemaVersion: 2, capacity: policy.capacity, ordering: policy.ordering,
        snapshot: { graphRevision: run.graph.revision, progress: run.progress, now } });
      if (!wave.selectedTaskIds.length) throw new RunStoreError('RUN_CAPACITY_OR_ORDER', diagnoseReservationWave(wave, 'application-empty', 0, policy.capacity));
      const identities = wave.selectedTaskIds.map(taskId => ({ ...run.identity, taskId,
        attemptId: identitySchema.parse(this.runtime.attemptId()), generation: 1 }));
      await this.authorization.authorize('reserve', command, principal);
      await this.poolAuthorization.authorize(policy.poolId, command.scopeId, principal);
      return this.project(await this.store.reserveRunTasks({ commandId: command.commandId, actor,
        scopeId: command.scopeId, runId: command.runId, expectedRevision: command.expectedRevision, now, identities }), command, actor);
    } catch (error) {
      if (!(error instanceof RunStoreError) || !['RUN_STORE_CONFLICT', 'RUN_COMMAND_CONFLICT'].includes(error.code)) throw error;
      // A competing identical command may have won with different generated IDs. Return its identities.
      const winner = await this.store.loadRunReceipt(command.scopeId, command.commandId);
      if (!winner) throw error;
      await this.authorization.authorize('reserve', command, principal);
      return this.project(winner, command, actor);
    }
  }
}
