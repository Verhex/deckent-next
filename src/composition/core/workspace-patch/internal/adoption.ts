import { resolve } from 'node:path';
import { SystemTrustedClock, ErrorRegistry, inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { GitIntegrationAdoption, GitIntegrationDelivery, GitRunWorkspaceProvider, GitWorkspaceBroker, LocalOsSessionAuthority, openSqliteAttemptStore,
  resolveGitWorkTarget, validateDockerSupervisorProfile } from '#adapters/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { RunPolicyAuthorization, WorkspaceAdoptionApplication, integrationAdoptionCommandSchema, integrationRollbackCommandSchema, workTargetAttemptAuthorization,
  type IntegrationAdoptionCommand, type IntegrationRollbackCommand } from '#engine/index.js';
import { criterionWithin } from '#capabilities/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { workspacePatchContext } from './configured.js';
/** Local SDK/CLI producer; target allow-list, paths, principal, session, Git options, the verification registry and bar never come from the wire. */
async function withAdoption<T>(root: string, identity: AttemptIdentity, options: ConfigLoadOptions, action: 'adopt-integration' | 'rollback-integration',
  use: (application: WorkspaceAdoptionApplication) => Promise<T>): Promise<T> {
  try {
    const c = await workspacePatchContext(root, identity, options, false, 'write');
    await c.authorization.authorizeIdentity(action, identity, c.principal);
    if (!c.config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    // K2 = A: moving a configured work target's branch also needs work-target:adopt on it (engine checks it first and before the effect).
    const target = await resolveGitWorkTarget(resolve(root), c.config.execution, c.layout), authorization = workTargetAttemptAuthorization(c.authorization, c.policySource, target.id);
    const git = { ...c.config.execution.git, ...target.git, workspaceRoot: await inspectProductDirectory(c.layout, 'workspaces') };
    const clock = new SystemTrustedClock();
    const sessions = await LocalOsSessionAuthority.create(c.principal.scopeIds, c.config.approvals.sessionTtlMs, clock);
    const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, 'forbid', { validate: validateDockerSupervisorProfile });
    try {
      const runs = new RunPolicyAuthorization({ async load() { return c.document; } });
      return await use(new WorkspaceAdoptionApplication(store, new GitIntegrationDelivery(git), new GitIntegrationAdoption(git),
        c.config.execution.adoption.targets, sessions, authorization, clock, { registry: c.config.admission?.registry ?? null,
          requirement: c.config.execution.adoption.verification, criterionWithin,
          authorizeRun: (scopeId, runId, principal) => runs.authorize('inspect', { scopeId, runId }, principal),
          source: new GitRunWorkspaceProvider(new GitWorkspaceBroker(git)) }));
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
