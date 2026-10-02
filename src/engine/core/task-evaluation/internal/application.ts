import { z } from 'zod';
import { attemptIdentitySchema, counterSchema, identitySchema, readWorkerModelPin, runSnapshotSchema, sameAttemptIdentity,
  taskEvaluationSchema, TaskEvaluationError, type AttemptIdentity, type CriterionDefinition,
  type EvaluatorDefinition, type RunSnapshot, type TaskEvaluationModel, type TaskEvaluation, type VerifiedPrincipal } from '#domain/index.js';
import type { ArtifactStore, EvaluationEvidenceLimits } from '#capabilities/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { AttemptStore } from '#engine/core/attempts/index.js';
import type { RunBoundDispatchStore, DispatchTerminal } from '#engine/core/dispatch/index.js';
import { assertRunExecution, projectRunView, RunStoreError, runLifecycleWriteSchema, type RunLifecycleStore, type RunReceipt, type RunStore } from '#engine/core/runs/index.js';
import { projectAttemptWorkerModels, readSealedWorkerEvents, type WorkerEventLogStore } from '#engine/core/worker-observation/index.js';
import { taskEvaluationCommitSchema, type TaskEvaluationStore } from './commit.js';
import { TaskEvidenceError, verifyDispatchEvaluationEvidence } from './evidence.js';
import { proposeTaskEvaluationCommit } from './transition.js';
import { evaluationRecovery } from './recovery.js';

export const taskEvaluationCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema,
  identity: attemptIdentitySchema, expectedRevision: counterSchema }).strict();
export type TaskEvaluationCommand = z.infer<typeof taskEvaluationCommandSchema>;
export interface TaskEvaluationAuthorization {
  authorize(identity: AttemptIdentity, principal: VerifiedPrincipal): Promise<void>;
}
export interface UnknownEvaluationPolicy {
  decide(evaluation: TaskEvaluation, principal: VerifiedPrincipal): Promise<'wait' | 'fail'>;
}
export interface TaskTerminalEvaluator {
  evaluate(evaluator: EvaluatorDefinition, criterion: CriterionDefinition, terminal: DispatchTerminal): Promise<'pass' | 'fail' | 'unknown'>;
}
type Store = TaskEvaluationStore & RunBoundDispatchStore & Pick<AttemptStore, 'load'> & Pick<RunStore, 'loadRun' | 'loadRunReceipt'>
  & Pick<WorkerEventLogStore, 'loadWorkerEventLog'> & Partial<Pick<RunLifecycleStore, 'commitRunLifecycle'>>;

/** Public result of an evaluation receipt: the Run view and, for a pinned worker attempt, the recorded model evidence (WORKER-CURRENCY-2). */
export function describeTaskEvaluationReceipt(receipt: RunReceipt) {
  const model = (JSON.parse(receipt.command) as { evaluation?: { model?: TaskEvaluationModel } }).evaluation?.model;
  return Object.freeze({ schemaVersion: 1 as const, commandId: receipt.commandId, run: projectRunView(receipt.snapshot), ...(model ? { model } : {}) });
}
/** Authenticated evaluation ingress. Wire input carries no verdict, evaluator, artifact, actor or paths.
 * Installed evaluator code consumes pinned definitions and verified terminal/output custody.
 */
export class TaskEvaluationApplication {
  constructor(private readonly store: Store, private readonly verifier: PrincipalVerifier,
    private readonly authorization: TaskEvaluationAuthorization, private readonly evaluator: TaskTerminalEvaluator,
    private readonly artifacts: Pick<ArtifactStore, 'read'>, private readonly limits: EvaluationEvidenceLimits,
    private readonly lifecycle: { now: () => number; timeoutMs: number }, private readonly unknownPolicy?: UnknownEvaluationPolicy) {}
  async execute(input: unknown, credential?: unknown) {
    const command = taskEvaluationCommandSchema.parse(input), principal = await authenticate(this.verifier, credential, command.identity.scopeId);
    await this.authorization.authorize(command.identity, principal);
    const replay = await this.store.loadRunReceipt(command.identity.scopeId, command.commandId);
    if (replay) {
      const { operation, action, ...value } = JSON.parse(replay.command);
      if (operation === 'run-lifecycle' && action === 'park-task') {
        const stored = runLifecycleWriteSchema.parse({ ...value, action });
        if (stored.expectedRevision !== command.expectedRevision || stored.runId !== command.identity.runId || stored.taskId !== command.identity.taskId
          || stored.actor.id !== principal.id || stored.actor.issuer !== principal.issuer || stored.actor.subject !== principal.subject) throw new RunStoreError('RUN_COMMAND_CONFLICT');
        const snapshot = runSnapshotSchema.parse(replay.snapshot);
        if (!snapshot.bindings.some(binding => sameAttemptIdentity(binding.identity, command.identity))) throw new RunStoreError('RUN_COMMAND_CONFLICT');
        if (snapshot.revision !== stored.expectedRevision + 1 || snapshot.identity.scopeId !== command.identity.scopeId
          || snapshot.identity.runId !== command.identity.runId || snapshot.identity.layoutRevision !== command.identity.layoutRevision) throw new RunStoreError('RUN_STORE_CORRUPT');
        return replay;
      }
    }
    try { return await this.evaluate(command, credential); }
    catch (error) {
      if (!(error instanceof TaskEvaluationError) || error.code !== 'TASK_EVALUATION_NOT_READY' || !this.store.commitRunLifecycle) throw error;
      const run = runSnapshotSchema.parse(await this.store.loadRun(command.identity.scopeId, command.identity.runId));
      const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, command.identity));
      const dispatch = await this.store.loadBoundDispatch(command.identity);
      // Only host-proven exited custody is parked. A live or uncertain effect keeps its slot and reconciliation owner.
      if (run.progress.find(value => value.taskId === command.identity.taskId)?.phase !== 'evaluating'
        || binding?.observedKind !== 'exited' || !dispatch?.terminal || run.cancelRequested
        || run.progress.find(value => value.taskId === command.identity.taskId)?.unresolvedEffects) throw error;
      await this.authorization.authorize(command.identity, principal);
      return this.store.commitRunLifecycle({ schemaVersion: 1, commandId: command.commandId, scopeId: command.identity.scopeId, runId: command.identity.runId,
        expectedRevision: command.expectedRevision, action: 'park-task', taskId: command.identity.taskId, reason: 'evaluation-not-ready',
        actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance },
        now: this.lifecycle.now(), timeoutMs: this.lifecycle.timeoutMs });
    }
  }
  private async evaluate(input: unknown, credential?: unknown) {
    const command = taskEvaluationCommandSchema.parse(input); const { identity } = command;
    const principal = await authenticate(this.verifier, credential, identity.scopeId);
    await this.authorization.authorize(identity, principal);
    const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    const replay = await this.store.loadRunReceipt(identity.scopeId, command.commandId);
    if (replay) {
      let stored;
      try {
        const { action, ...payload } = JSON.parse(replay.command);
        if (action !== 'apply-task-evaluation') throw new Error();
        stored = taskEvaluationCommitSchema.parse(payload);
      } catch { throw new RunStoreError('RUN_COMMAND_CONFLICT'); }
      if (stored.commandId !== command.commandId || stored.expectedRevision !== command.expectedRevision
        || !sameAttemptIdentity(stored.evaluation.identity, identity) || JSON.stringify(stored.actor) !== JSON.stringify(actor)) {
        throw new RunStoreError('RUN_COMMAND_CONFLICT');
      }
      const snapshot = runSnapshotSchema.parse(replay.snapshot);
      if (snapshot.identity.scopeId !== identity.scopeId || snapshot.identity.runId !== identity.runId
        || snapshot.identity.layoutRevision !== identity.layoutRevision || snapshot.revision !== stored.expectedRevision + 1
        || !snapshot.bindings.some(binding => sameAttemptIdentity(binding.identity, identity)
          && binding.observedRevision === stored.evaluation.attemptRevision)) throw new RunStoreError('RUN_STORE_CORRUPT');
      assertRunExecution(snapshot.graph, snapshot.execution);
      return replay;
    }
    const run = runSnapshotSchema.parse(await this.store.loadRun(identity.scopeId, identity.runId));
    assertRunExecution(run.graph, run.execution);
    const attempt = await this.store.load(identity.scopeId, identity.attemptId);
    const dispatch = await this.store.loadBoundDispatch(identity);
    if (!attempt || !dispatch?.terminal || !dispatch.output) throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
    const task = run.graph.tasks.find(value => value.id === identity.taskId);
    if (!task) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
    const evidenceId = 'dispatch-output';
    const model = await this.workerModel(run, identity);
    const recovery = await evaluationRecovery(this.store, run, identity, dispatch, model);
    const proposed = taskEvaluationSchema.parse({ schemaVersion: 1, evaluationId: command.commandId, identity,
      graphRevision: run.graph.revision, attemptRevision: attempt.revision,
      criteria: task.acceptanceCriteria.map(criterionId => ({ criterionId, verdict: 'unknown', evidenceIds: [evidenceId] })),
      ...(model ? { model } : {}), ...recovery,
    });
    proposeTaskEvaluationCommit(run, attempt, dispatch, command.expectedRevision, proposed, { now: this.lifecycle.now(), timeoutMs: this.lifecycle.timeoutMs });
    await verifyDispatchEvaluationEvidence(proposed, dispatch.request, [{ evidenceId, receipt: dispatch.output }],
      { async readDispatch() { return dispatch; } }, this.artifacts, this.limits);
    const criteria = [];
    for (const item of proposed.criteria) {
      const criterion = run.graph.criterionDefinitions.find(value => value.id === item.criterionId)!;
      const selected = run.execution.criteria.find(value => value.criterionId === item.criterionId)!;
      criteria.push({ ...item, verdict: await this.evaluator.evaluate(selected.evaluator, criterion, dispatch.terminal) });
    }
    const evaluation = taskEvaluationSchema.parse({ ...proposed, criteria });
    const restriction = await this.unknownPolicy?.decide(evaluation, principal);
    if (restriction !== undefined && restriction !== 'wait' && restriction !== 'fail') throw new TaskEvaluationError('TASK_EVALUATION_INVALID');
    await this.authorization.authorize(identity, principal);
    return this.store.commitTaskEvaluation({ commandId: command.commandId, actor,
      expectedRevision: command.expectedRevision, evaluation, dispatch,
      ...(restriction === 'fail' ? { unknownDisposition: 'fail' as const } : {}),
      now: this.lifecycle.now(), timeoutMs: this.lifecycle.timeoutMs });
  }
  /**
   * Worker model evidence of a pinned attempt (WORKER-CURRENCY-2, owner rule A; Jev 933e43f2, 58ffe1c9): the host-sealed verdict from the
   * sealed event log, recorded with the evaluation; the domain turns `substituted` into a failed Task and a Claude attempt without a
   * sealed `verified` verdict into a hold. A present but unreadable log refuses evaluation (typed, nothing recorded): never a silent pass.
   */
  private async workerModel(run: RunSnapshot, identity: AttemptIdentity): Promise<TaskEvaluationModel | undefined> {
    if (!readWorkerModelPin(run.execution.tasks.find(entry => entry.taskId === identity.taskId)?.profile.parameters)) return undefined;
    let sealed;
    try { sealed = await readSealedWorkerEvents(this.store, this.artifacts, identity); }
    catch { throw new TaskEvidenceError('TASK_EVIDENCE_INVALID'); }
    const view = projectAttemptWorkerModels(run, identity.taskId, sealed)!;
    return { provider: view.provider, requested: view.requested, init: view.init, usage: view.usage,
      verdict: view.verdict === 'pending' ? 'unverified' : view.verdict, unexpected: view.unexpected, evidence: sealed ? 'sealed' : 'absent' };
  }
}
