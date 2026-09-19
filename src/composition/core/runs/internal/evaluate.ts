import { userInfo } from 'node:os';
import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { evaluateProcessExit, validateProcessExitCriterion } from '#capabilities/index.js';
import { authenticate, TaskEvaluationApplication, taskEvaluationCommandSchema, DispatchPolicyAuthorization, projectRunView, type TaskEvaluationCommand } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

/** Installed process-exit evaluator. The current registry cannot replace a Run's pinned definitions. */
export async function evaluateConfiguredTask(projectRoot: string, input: TaskEvaluationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = taskEvaluationCommandSchema.parse(input);
    const { config, layout, principal, path } = await loadConfiguredScopeContext(projectRoot, command.identity.scopeId, options);
    const verifier = { async verify() { return principal; } };
    const policy = new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
    const authorization = { authorize: (identity: typeof command.identity, actor: typeof principal) => policy.authorizeIdentity('evaluate', identity, actor) };
    await authorization.authorize(command.identity, await authenticate(verifier, undefined, command.identity.scopeId));
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      const artifacts = new FileArtifactStore({ root: await inspectProductDirectory(layout, 'artifacts'), maxBytes: config.artifacts.maxBytes });
      const application = new TaskEvaluationApplication(store, verifier, authorization, {
        async evaluate(evaluator, criterion, terminal) {
          validateProcessExitCriterion(evaluator, criterion);
          return evaluateProcessExit(criterion.parameters, { exitCode: terminal.exitCode,
            ...(terminal.signal === undefined ? {} : { signal: terminal.signal }) });
        },
      }, artifacts, { maxEvidenceItems: 1, maxTotalBytes: config.artifacts.maxBytes });
      // One retained dispatch-output receipt is the supported producer contract, not a configurable task limit.
      const receipt = await application.execute(command);
      return Object.freeze({ schemaVersion: 1 as const, layout,
        evaluation: Object.freeze({ schemaVersion: 1 as const, commandId: receipt.commandId, run: projectRunView(receipt.snapshot) }) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
