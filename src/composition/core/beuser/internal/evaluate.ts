import { userInfo } from 'node:os';
import { FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { createInstalledTerminalEvaluator } from '#capabilities/index.js';
import { TaskEvaluationApplication, DispatchPolicyAuthorization, RunPolicyAuthorization, beuserEvaluatorFor, assertBeuserAccess, type BeuserContext } from '#engine/index.js';
import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
/** The system evaluator consumes the retained dispatch file through the existing acceptance owner. */
export async function evaluateConfiguredBeuserTask(root: string, context: BeuserContext, commandId: string, options: ConfigLoadOptions) {
  const identity = context.binding.identity, c = await loadConfiguredScopeContext(root, identity.scopeId, options, 'write');
  const principal = beuserEvaluatorFor(c.principal, identity.scopeId);
  assertBeuserAccess(context, context.binding, principal, { kind: 'attempt', id: identity.attemptId }, 'evaluate');
  const source = createLayoutPolicySource(c.layout, userInfo().uid, c.config.inspection.policyMaxBytes), policy = new DispatchPolicyAuthorization(source);
  const authorization = { authorize: (id: typeof identity, actor: typeof principal) => policy.authorizeIdentity('evaluate', id, actor) };
  await authorization.authorize(identity, principal);
  await new RunPolicyAuthorization(source).authorize('inspect', identity, principal);
  const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, { now: Date.now, timeoutMs: c.config.runRuntime.parking.timeoutMs }, 'forbid');
  try {
    const artifacts = new FileArtifactStore({ root: await inspectProductDirectory(c.layout, 'artifacts'), maxBytes: c.config.artifacts.maxBytes });
    const run = await store.loadRun(identity.scopeId, identity.runId);
    const app = new TaskEvaluationApplication(store, { verify: async () => principal }, authorization, createInstalledTerminalEvaluator(store), artifacts,
      { maxEvidenceItems: 2, maxTotalBytes: c.config.artifacts.maxBytes }, { now: Date.now, timeoutMs: c.config.runRuntime.parking.timeoutMs });
    return await app.execute({ schemaVersion: 1, commandId, identity, expectedRevision: run!.revision });
  } finally { store.close(); }
}
