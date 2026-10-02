import { userInfo } from 'node:os'; import { resolve } from 'node:path'; import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, openSqliteAttemptStore, resolveGitWorkTarget, validateDockerSupervisorProfile, gitDockerAttemptCustody } from '#adapters/index.js';
import { AttemptCustodyReleaseApplication, DispatchPolicyAuthorization, sweepAttemptCustodyScopes } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js'; import { queryFailure } from '#composition/core/query-errors/index.js'; import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
/** EXEC-RELEASE service-start sweep (under the service's ledger custody): the same release owner and ledger condition as patch preparation. */
export async function sweepConfiguredAttemptCustody(root: string, scopeIds: readonly string[], options: ConfigLoadOptions = {}) {
  return sweepAttemptCustodyScopes(scopeIds, async scopeId => {
    const c = await loadConfiguredScopeContext(root, scopeId, options, 'read'), execution = c.config.execution, layout = c.layout; if (!execution) return null;
    const git = { ...execution.git, ...(await resolveGitWorkTarget(resolve(root), execution, layout)).git, workspaceRoot: await inspectProductDirectory(layout, 'workspaces') };
    const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, { now: Date.now, timeoutMs: c.config.runRuntime.parking.timeoutMs }, 'forbid', { validate: validateDockerSupervisorProfile });
    try { return await new AttemptCustodyReleaseApplication({ store, artifacts: new FileArtifactStore({ root: await inspectProductDirectory(layout, 'artifacts'), maxBytes: c.config.artifacts.maxBytes }),
      verifier: { async verify() { return c.principal; } }, authorization: new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, c.config.inspection.policyMaxBytes)),
      owner: c.principal.id, retention: execution.retention, ...gitDockerAttemptCustody(git) }).sweep(scopeId, c.config.inspection.maxPageSize); } finally { store.close(); }
  }, error => queryFailure(error).code);
}
