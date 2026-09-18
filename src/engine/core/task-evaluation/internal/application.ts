import { z } from 'zod';
import { attemptIdentitySchema, counterSchema, identitySchema, runSnapshotSchema, sameAttemptIdentity,
  taskEvaluationSchema, TaskEvaluationError, type AttemptIdentity, type CriterionDefinition,
  type EvaluatorDefinition, type VerifiedPrincipal } from '#domain/index.js';
import type { ArtifactStore, EvaluationEvidenceLimits } from '#capabilities/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { AttemptStore } from '#engine/core/attempts/index.js';
import type { RunBoundDispatchStore, DispatchTerminal } from '#engine/core/dispatch/index.js';
import { assertRunExecution, RunStoreError, type RunStore } from '#engine/core/runs/index.js';
import { taskEvaluationCommitSchema, type TaskEvaluationStore } from './commit.js';
import { verifyDispatchEvaluationEvidence } from './evidence.js';
import { proposeTaskEvaluationCommit } from './transition.js';

export const taskEvaluationCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema,
  identity: attemptIdentitySchema, expectedRevision: counterSchema }).strict();
export type TaskEvaluationCommand = z.infer<typeof taskEvaluationCommandSchema>;
export interface TaskEvaluationAuthorization {
  authorize(identity: AttemptIdentity, principal: VerifiedPrincipal): Promise<void>;
}
export interface TaskTerminalEvaluator {
  evaluate(evaluator: EvaluatorDefinition, criterion: CriterionDefinition, terminal: DispatchTerminal): Promise<'pass' | 'fail' | 'unknown'>;
}
type Store = TaskEvaluationStore & RunBoundDispatchStore & Pick<AttemptStore, 'load'> & Pick<RunStore, 'loadRun' | 'loadRunReceipt'>;

/** Authenticated evaluation ingress. Wire input carries no verdict, evaluator, artifact, actor or paths.
 * Installed evaluator code consumes pinned definitions and verified terminal/output custody.
 */
export class TaskEvaluationApplication {
  constructor(private readonly store: Store, private readonly verifier: PrincipalVerifier,
    private readonly authorization: TaskEvaluationAuthorization, private readonly evaluator: TaskTerminalEvaluator,
    private readonly artifacts: Pick<ArtifactStore, 'read'>, private readonly limits: EvaluationEvidenceLimits) {}
  async execute(input: unknown, credential?: unknown) {
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
    const proposed = taskEvaluationSchema.parse({ schemaVersion: 1, evaluationId: command.commandId, identity,
      graphRevision: run.graph.revision, attemptRevision: attempt.revision,
      criteria: task.acceptanceCriteria.map(criterionId => ({ criterionId, verdict: 'unknown', evidenceIds: [evidenceId] })),
    });
    proposeTaskEvaluationCommit(run, attempt, dispatch, command.expectedRevision, proposed);
    await verifyDispatchEvaluationEvidence(proposed, dispatch.request, [{ evidenceId, receipt: dispatch.output }],
      { async readDispatch() { return dispatch; } }, this.artifacts, this.limits);
    const criteria = [];
    for (const item of proposed.criteria) {
      const criterion = run.graph.criterionDefinitions.find(value => value.id === item.criterionId)!;
      const selected = run.execution.criteria.find(value => value.criterionId === item.criterionId)!;
      criteria.push({ ...item, verdict: await this.evaluator.evaluate(selected.evaluator, criterion, dispatch.terminal) });
    }
    const evaluation = taskEvaluationSchema.parse({ ...proposed, criteria });
    await this.authorization.authorize(identity, principal);
    return this.store.commitTaskEvaluation({ commandId: command.commandId, actor,
      expectedRevision: command.expectedRevision, evaluation, dispatch });
  }
}
