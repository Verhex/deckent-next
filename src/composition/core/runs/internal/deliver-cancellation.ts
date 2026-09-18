import { userInfo } from 'node:os';
import { inspectProductDirectory, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { DockerSupervisor, FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { authenticate, RunApplication, runCommandSchema, RunPolicyAuthorization, DispatchApplication, DispatchPolicyAuthorization,
  RunCancellationCoordinator, type RunCommand } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredRunContext } from './context.js';
/** Explicit delivery, separate from request-only SDK entry. Current Run and per-Attempt policy gate
 * every delivery; stopped containers stay retained until independent output durability/release.
 */
export async function deliverConfiguredRunCancellation(projectRoot: string, input: RunCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = runCommandSchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredRunContext(projectRoot, command.scopeId, options);
    const verifier = { async verify() { return principal; } }; const authorization = new RunPolicyAuthorization({ async load() { return document; } });
    const actor = await authenticate(verifier, undefined, command.scopeId);
    await authorization.authorize('cancel', command, actor);
    if (!config.cancellation || !config.execution) throw ErrorRegistry.createError('CANCELLATION_NOT_CONFIGURED');
    const os = userInfo();
    const workspaceRoot = await inspectProductDirectory(layout, 'workspaces');
    const artifactRoot = await inspectProductDirectory(layout, 'artifacts');
    const supervisor = new DockerSupervisor({ ...config.execution.docker, workspaceRoot, uid: os.uid, gid: os.gid });
    const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: config.artifacts.maxBytes });
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      const runs = new RunApplication(store, verifier, authorization);
      const dispatchPolicy = new DispatchPolicyAuthorization(createLayoutPolicySource(layout, os.uid, config.inspection.policyMaxBytes));
      const dispatch = new DispatchApplication(store, supervisor, verifier, dispatchPolicy, principal.id, artifacts);
      const coordinator = new RunCancellationCoordinator(runs, store, dispatch, config.cancellation.maxConcurrentDeliveries);
      return Object.freeze({ schemaVersion: 1 as const, layout, delivery: await coordinator.cancel(command) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
