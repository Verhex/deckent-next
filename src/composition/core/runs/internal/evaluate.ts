import { prepareConfiguredEvaluationPatch } from '#composition/core/workspace-patch/index.js';
import { userInfo } from 'node:os';
import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, openSqliteAttemptStore, inventoryReadsPerCall } from '#adapters/index.js';
import { createInstalledTerminalEvaluator } from '#capabilities/index.js';
import { authenticate, describeTaskEvaluationReceipt, readAttemptHandoffEvents, TaskEvaluationApplication, taskEvaluationCommandSchema, DispatchPolicyAuthorization, type TaskEvaluationCommand, type HandoffStartRecord } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { observeConfiguredRunResults } from './result-view.js';
/** Installed implementation selection. The current registry cannot replace a Run's pinned definitions. */
export async function evaluateConfiguredTask(projectRoot: string, input: TaskEvaluationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = taskEvaluationCommandSchema.parse(input);
    const { config, layout, principal, path } = await loadConfiguredScopeContext(projectRoot, command.identity.scopeId, options, 'write');
    const verifier = { async verify() { return principal; } };
    const policy = new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
    const authorization = { authorize: (identity: typeof command.identity, actor: typeof principal) => policy.authorizeIdentity('evaluate', identity, actor) };
    await authorization.authorize(command.identity, await authenticate(verifier, undefined, command.identity.scopeId));
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
    try {
      const artifacts = new FileArtifactStore({ root: await inspectProductDirectory(layout, 'artifacts'), maxBytes: config.artifacts.maxBytes });
      // One retained dispatch-output receipt is the supported producer contract, not a configurable task limit.
      const application = new TaskEvaluationApplication(store, verifier, authorization, createInstalledTerminalEvaluator(store), artifacts, { maxEvidenceItems: 1, maxTotalBytes: config.artifacts.maxBytes }, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, undefined, async identity => { await prepareConfiguredEvaluationPatch(projectRoot, identity, options); });
      const receipt = await application.execute(command);
      // Use inspection's canonical receipt reader, pinned to this response's revision even on replay.
      const reader = inventoryReadsPerCall(path, { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
      const evaluations = await reader.loadRunEvaluations(receipt.snapshot);
      const handoffs: HandoffStartRecord[] = [];
      for (const binding of receipt.snapshot.bindings) {
        const handoff = await readAttemptHandoffEvents(reader, binding.identity);
        if (handoff) handoffs.push(handoff);
      }
      const evaluation = describeTaskEvaluationReceipt(receipt, evaluations, handoffs);
      const run = await observeConfiguredRunResults(config, options.env, evaluation.run, principal, policy, receipt.snapshot);
      return Object.freeze({ schemaVersion: 1 as const, layout, evaluation: Object.freeze({ ...evaluation, run }) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
