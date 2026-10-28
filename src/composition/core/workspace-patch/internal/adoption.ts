import { resolve } from 'node:path';
import { SystemTrustedClock, ErrorRegistry, getConfigKnownSecrets, inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { GitIntegrationAdoption, GitIntegrationDelivery, GitRunWorkspaceProvider, GitWorkspaceBroker, LocalOsSessionAuthority, openSqliteAttemptStore,
  resolveGitWorkTarget, validateDockerSupervisorProfile } from '#adapters/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { RunPolicyAuthorization, WorkspaceAdoptionApplication, integrationAdoptionCommandSchema, integrationRollbackCommandSchema,
  type IntegrationAdoptionCommand, type IntegrationRollbackCommand, type EffectConfirmation } from '#engine/index.js';
import { criterionWithin } from '#capabilities/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { workspacePatchContext } from './configured.js';
/** Local SDK/CLI producer; target allow-list, paths, principal, session, Git options, the verification registry and bar never come from the wire. */
async function withAdoption<T>(root: string, identity: AttemptIdentity, options: ConfigLoadOptions, action: 'adopt-integration' | 'rollback-integration',
  use: (application: WorkspaceAdoptionApplication) => Promise<T>, confirmation?: EffectConfirmation): Promise<T> {
  try {
    const c = await workspacePatchContext(root, identity, options, false, 'write');
    await c.authorization.authorizeIdentity(action, identity, c.principal);
    if (!c.config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    const target = await resolveGitWorkTarget(resolve(root), c.config.execution, c.layout);
    const git = { ...c.config.execution.git, ...target.git, workspaceRoot: await inspectProductDirectory(c.layout, 'workspaces') };
    const clock = new SystemTrustedClock();
    const sessions = await LocalOsSessionAuthority.create(c.principal.scopeIds, c.config.approvals.sessionTtlMs, clock);
    const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, { now: Date.now, timeoutMs: c.config.runRuntime.parking.timeoutMs }, 'forbid', { validate: validateDockerSupervisorProfile });
    try { await c.sameWorkSource(store);
      const runs = new RunPolicyAuthorization({ async load() { return c.document; } });
      return await use(new WorkspaceAdoptionApplication(store, new GitIntegrationDelivery(git), new GitIntegrationAdoption(git),
        c.config.execution.adoption.targets, sessions, c.authorization, clock, { registry: c.config.admission?.registry ?? null,
          requirement: c.config.execution.adoption.verification, criterionWithin,
          authorizeRun: (scopeId, runId, principal) => runs.authorize('inspect', { scopeId, runId }, principal),
          source: new GitRunWorkspaceProvider(new GitWorkspaceBroker(git)) }, confirmation, getConfigKnownSecrets(c.config)));
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
export async function adoptWorkspaceIntegrationWithConfirmation(root: string, input: IntegrationAdoptionCommand, options: ConfigLoadOptions, confirmation?: EffectConfirmation) {
  let command; try { command = integrationAdoptionCommandSchema.parse(input); } catch (error) { throw queryFailure(error); }
  return withAdoption(root, command.identity, options, 'adopt-integration', application => application.adopt(command), confirmation);
}
export async function rollbackWorkspaceIntegrationWithConfirmation(root: string, input: IntegrationRollbackCommand, options: ConfigLoadOptions, confirmation?: EffectConfirmation) {
  let command; try { command = integrationRollbackCommandSchema.parse(input); } catch (error) { throw queryFailure(error); }
  return withAdoption(root, command.identity, options, 'rollback-integration', application => application.rollback(command), confirmation);
}
export const rollbackConfiguredWorkspaceIntegration = (root: string, input: IntegrationRollbackCommand, options: ConfigLoadOptions = {}) => rollbackWorkspaceIntegrationWithConfirmation(root, input, options); // SDK: no answer, refused like adoption
export const adoptConfiguredWorkspaceIntegration = (root: string, input: IntegrationAdoptionCommand, options: ConfigLoadOptions = {}) => adoptWorkspaceIntegrationWithConfirmation(root, input, options);
