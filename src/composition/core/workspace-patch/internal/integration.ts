import { resolve } from 'node:path';
import { ArtifactError } from '#capabilities/index.js';
import { ErrorRegistry, inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { GitIntegrationTarget, openSqliteAttemptStore, openSqliteInventoryReader, validateDockerSupervisorProfile } from '#adapters/index.js';
import { WorkspacePatchApplication, WorkspaceIntegrationApplication, integrationCommandSchema, type IntegrationCommand, type RunBoundDispatchStore } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { workspacePatchContext } from './configured.js';
async function application(root: string, c: Awaited<ReturnType<typeof workspacePatchContext>>, store: RunBoundDispatchStore) {
  if (!c.config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
  const target = new GitIntegrationTarget({ ...c.config.execution.git, sourceRoot: resolve(root), workspaceRoot: await inspectProductDirectory(c.layout, 'workspaces') },
    { ...c.config.artifacts.patchPreview, maxBytes: c.config.artifacts.maxBytes });
  const patches = new WorkspacePatchApplication(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes);
  return new WorkspaceIntegrationApplication(patches, target, c.verifier, c.authorization, c.artifacts, c.config.artifacts.maxBytes);
}
export async function checkConfiguredWorkspaceIntegration(root: string, identity: AttemptIdentity, options: ConfigLoadOptions = {}) {
  try {
    const c = await workspacePatchContext(root, identity, options, false);
    const store = await openSqliteInventoryReader(await c.path(), { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
    try { return await (await application(root, c, store)).check(identity); } finally { store.close(); }
  } catch (error) { throw error instanceof ArtifactError ? ErrorRegistry.createError('PATCH_CORRUPT') : queryFailure(error); }
}
export async function prepareConfiguredWorkspaceIntegration(root: string, input: IntegrationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = integrationCommandSchema.parse(input);
    const c = await workspacePatchContext(root, command.identity, options, false);
    await c.authorization.authorizeIdentity('prepare-integration', command.identity, c.principal);
    const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, 'forbid', { validate: validateDockerSupervisorProfile });
    try { return await (await application(root, c, store)).prepare(command, store); } finally { store.close(); }
  } catch (error) { throw error instanceof ArtifactError ? ErrorRegistry.createError('PATCH_CORRUPT') : queryFailure(error); }
}
