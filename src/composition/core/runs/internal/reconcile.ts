import { userInfo } from 'node:os';
import { inspectProductDirectory, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { DockerSupervisor, FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { authenticate, DispatchApplication, DispatchPolicyAuthorization, DispatchError, type DispatchStore, type RunBoundDispatchStore, type DispatchAuthorization, type DispatchIdentityAuthorization } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredRunContext } from './context.js';
/** Reconcile a recorded attempt; callers cannot supply executable, workspace or supervisor options.
 * Observation may settle an exited process, never launch/retry it or accept a Task's business result.
 */
export async function reconcileConfiguredAttempt(projectRoot: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) {
  try {
    const identity = attemptIdentitySchema.parse(input);
    const { config, layout, principal, path } = await loadConfiguredRunContext(projectRoot, identity.scopeId, options);
    const os = userInfo(); const verifier = { async verify() { return principal; } };
    const authorization: DispatchAuthorization & DispatchIdentityAuthorization = new DispatchPolicyAuthorization(createLayoutPolicySource(layout, os.uid, config.inspection.policyMaxBytes));
    const actor = await authenticate(verifier, undefined, identity.scopeId);
    await authorization.authorizeIdentity('reconcile', identity, actor);
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      const dispatchStore: DispatchStore & RunBoundDispatchStore = store;
      const recorded = await dispatchStore.loadBoundDispatch(identity);
      if (!recorded) throw new DispatchError('DISPATCH_NOT_ADMITTED');
      if (!config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
      const workspaceRoot = await inspectProductDirectory(layout, 'workspaces');
      const artifactRoot = await inspectProductDirectory(layout, 'artifacts');
      const supervisor = new DockerSupervisor({ ...config.execution.docker, workspaceRoot, uid: os.uid, gid: os.gid });
      const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: config.artifacts.maxBytes });
      const app = new DispatchApplication(dispatchStore, supervisor, verifier, authorization, principal.id, artifacts);
      const result = await app.reconcile(recorded.request);
      return Object.freeze({ schemaVersion: 1 as const, layout, reconciliation: Object.freeze({
        identity, status: result.kind, terminal: result.record.terminal, outputRecorded: !!result.record.output,
      }) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
