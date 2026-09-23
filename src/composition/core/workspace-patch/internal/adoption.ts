import { resolve } from 'node:path';
import { SystemTrustedClock, ErrorRegistry, inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { GitIntegrationAdoption, GitIntegrationDelivery, LocalOsSessionAuthority, openSqliteAttemptStore, validateDockerSupervisorProfile } from '#adapters/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { WorkspaceAdoptionApplication, integrationAdoptionCommandSchema, integrationRollbackCommandSchema,
  type IntegrationAdoptionCommand, type IntegrationRollbackCommand } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { workspacePatchContext } from './configured.js';
/** Local SDK/CLI producer; target allow-list, paths, principal, session and Git options never come from the wire. */
async function withAdoption<T>(root: string, identity: AttemptIdentity, options: ConfigLoadOptions, action: 'adopt-integration' | 'rollback-integration',
  use: (application: WorkspaceAdoptionApplication) => Promise<T>): Promise<T> {
  try {
    const c = await workspacePatchContext(root, identity, options, false);
    await c.authorization.authorizeIdentity(action, identity, c.principal);
    if (!c.config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    const git = { ...c.config.execution.git, sourceRoot: resolve(root), workspaceRoot: await inspectProductDirectory(c.layout, 'workspaces') };
    const clock = new SystemTrustedClock();
    const sessions = await LocalOsSessionAuthority.create(c.principal.scopeIds, c.config.approvals.sessionTtlMs, clock);
    const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, 'forbid', { validate: validateDockerSupervisorProfile });
    try {
      return await use(new WorkspaceAdoptionApplication(store, new GitIntegrationDelivery(git), new GitIntegrationAdoption(git),
        c.config.execution.adoption.targets, sessions, c.authorization, clock));
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
export async function adoptConfiguredWorkspaceIntegration(root: string, input: IntegrationAdoptionCommand, options: ConfigLoadOptions = {}) {
  let command; try { command = integrationAdoptionCommandSchema.parse(input); } catch (error) { throw queryFailure(error); }
  return withAdoption(root, command.identity, options, 'adopt-integration', application => application.adopt(command));
}
export async function rollbackConfiguredWorkspaceIntegration(root: string, input: IntegrationRollbackCommand, options: ConfigLoadOptions = {}) {
  let command; try { command = integrationRollbackCommandSchema.parse(input); } catch (error) { throw queryFailure(error); }
  return withAdoption(root, command.identity, options, 'rollback-integration', application => application.rollback(command));
}
