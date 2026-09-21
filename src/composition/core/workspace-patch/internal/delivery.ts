import { resolve } from 'node:path';
import { SystemTrustedClock, ErrorRegistry, inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { GitIntegrationTarget, GitIntegrationDelivery, LocalOsSessionAuthority, openSqliteAttemptStore, validateDockerSupervisorProfile } from '#adapters/index.js';
import { WorkspacePatchApplication, WorkspaceIntegrationInspection, WorkspaceDeliveryApplication, integrationDeliveryCommandSchema, type IntegrationDeliveryCommand } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { workspacePatchContext } from './configured.js';
/** Local SDK/CLI producer; paths, principal, session and Git options never come from the wire. */
export async function deliverConfiguredWorkspaceIntegration(root: string, input: IntegrationDeliveryCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = integrationDeliveryCommandSchema.parse(input);
    const c = await workspacePatchContext(root, command.identity, options, false);
    await c.authorization.authorizeIdentity('deliver-integration', command.identity, c.principal);
    if (!c.config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    const git = { ...c.config.execution.git, sourceRoot: resolve(root), workspaceRoot: await inspectProductDirectory(c.layout, 'workspaces') };
    const target = new GitIntegrationTarget(git, { ...c.config.artifacts.patchPreview, maxBytes: c.config.artifacts.maxBytes });
    const clock = new SystemTrustedClock();
    const sessions = await LocalOsSessionAuthority.create(c.principal.scopeIds, c.config.approvals.sessionTtlMs, clock);
    const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, 'forbid', { validate: validateDockerSupervisorProfile });
    try {
      const patches = new WorkspacePatchApplication(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes);
      const inspection = new WorkspaceIntegrationInspection(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes);
      return await new WorkspaceDeliveryApplication(patches, inspection, target, new GitIntegrationDelivery(git), store,
        sessions, c.authorization, clock).deliver(command);
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
