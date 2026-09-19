import { userInfo } from 'node:os';
import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { authenticate, DispatchApplication, DispatchPolicyAuthorization, DispatchError, parseRetainedOutputEnvelope,
  type DispatchAuthorization, type DispatchIdentityAuthorization, type DispatchStore, type RunBoundDispatchStore } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredRunContext } from './context.js';
import { recordedSupervisor } from './recorded-supervisor.js';

/** Recover bounded retained logs under recorded execution custody. Recovered evidence stays partial;
 * this operation neither relaunches a worker nor evaluates or accepts the Task.
 */
export async function recoverConfiguredAttemptOutput(projectRoot: string, input: AttemptIdentity,
  options: ConfigLoadOptions = {}) {
  try {
    const identity = attemptIdentitySchema.parse(input);
    const { config, layout, principal, path } = await loadConfiguredRunContext(projectRoot, identity.scopeId, options);
    const verifier = { async verify() { return principal; } };
    const authorization: DispatchAuthorization & DispatchIdentityAuthorization = new DispatchPolicyAuthorization(
      createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
    const actor = await authenticate(verifier, undefined, identity.scopeId);
    await authorization.authorizeIdentity('recover-output', identity, actor);
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      const dispatchStore: DispatchStore & RunBoundDispatchStore = store;
      const recorded = await dispatchStore.loadBoundDispatch(identity);
      if (!recorded) throw new DispatchError('DISPATCH_NOT_ADMITTED');
      const artifactRoot = await inspectProductDirectory(layout, 'artifacts');
      const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: config.artifacts.maxBytes });
      const application = new DispatchApplication(dispatchStore, recordedSupervisor(recorded.profile), verifier,
        authorization, principal.id, artifacts);
      const recovered = await application.recoverOutput(recorded.request);
      if (!recovered.output) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
      const envelope = parseRetainedOutputEnvelope(await artifacts.read(identity.scopeId, recovered.output), identity);
      return Object.freeze({ schemaVersion: 1 as const, layout, recovery: Object.freeze({
        identity, outputRecorded: true as const, completeness: envelope.completeness,
      }) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
