import { randomUUID } from 'node:crypto';
import { recordedSupervisor } from './recorded-supervisor.js';
import { userInfo } from 'node:os';
import { inspectProductDirectory, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { authenticate, RunApplication, runCommandSchema, RunPolicyAuthorization, DispatchApplication, DispatchPolicyAuthorization,
  RunCancellationCoordinator, DispatchError, sandboxRequestSchema, type SandboxRequest, type RunCommand } from '#engine/index.js';
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
    if (!config.cancellation) throw ErrorRegistry.createError('CANCELLATION_NOT_CONFIGURED', {
      params: { missing: 'cancellation' },
    });
    const os = userInfo();
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      const runs = new RunApplication(store, verifier, authorization);
      const createDispatch = async (request: SandboxRequest) => {
        const recorded = await store.loadCancellationDispatch(request.identity);
        if (!recorded) throw new DispatchError('DISPATCH_NOT_ADMITTED');
        const artifactRoot = await inspectProductDirectory(layout, 'artifacts');
        const supervisor = recordedSupervisor(recorded.profile);
        const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: config.artifacts.maxBytes });
        const dispatchPolicy = new DispatchPolicyAuthorization(createLayoutPolicySource(layout, os.uid, config.inspection.policyMaxBytes));
        return new DispatchApplication(store, supervisor, verifier, dispatchPolicy, principal.id, artifacts);
      };
      // No runtime dependency is touched for an attempt that has never been dispatched.
      // Each attempt has its own immutable profile; never share one mutable configuration across workers.
      const delivery: Pick<DispatchApplication, 'cancel' | 'authorizeCancellation'> = {
        async authorizeCancellation(request, credential) { const parsed = sandboxRequestSchema.parse(request); await (await createDispatch(parsed)).authorizeCancellation(parsed, credential); },
        async cancel(request, credential) { const parsed = sandboxRequestSchema.parse(request); return (await createDispatch(parsed)).cancel(parsed, credential); },
      };
      const coordinator = new RunCancellationCoordinator(runs, store, delivery, config.cancellation, { now: Date.now, token: randomUUID });
      return Object.freeze({ schemaVersion: 1 as const, layout, delivery: await coordinator.cancel(command) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
