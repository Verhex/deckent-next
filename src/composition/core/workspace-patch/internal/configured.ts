import { ArtifactError } from '#capabilities/index.js';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { ErrorRegistry, inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { FileArtifactStore, GitWorkspacePatchSource, openSqliteAttemptStore, openSqliteInventoryReader, validateDockerSupervisorProfile } from '#adapters/index.js';
import { DispatchPolicyAuthorization, WorkspacePatchApplication } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
export async function workspacePatchContext(root: string, input: unknown, options: ConfigLoadOptions, preparing: boolean) {
  const identity = attemptIdentitySchema.parse(input);
  const context = await loadConfiguredScopeContext(root, identity.scopeId, options);
  const { config, layout, principal } = context;
  const authorization = new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
  await authorization.authorizeIdentity('read-output', identity, principal);
  if (preparing) await authorization.authorizeIdentity('recover-output', identity, principal);
  const artifacts = new FileArtifactStore({ root: await inspectProductDirectory(layout, 'artifacts'), maxBytes: config.artifacts.maxBytes });
  return { ...context, identity, artifacts, authorization, verifier: { async verify() { return principal; } } };
}
export async function prepareConfiguredWorkspacePatch(root: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) {
  try {
    const c = await workspacePatchContext(root, input, options, true);
    if (!c.config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, 'forbid', { validate: validateDockerSupervisorProfile });
    try {
      const source = new GitWorkspacePatchSource({ ...c.config.execution.git, sourceRoot: resolve(root),
        workspaceRoot: await inspectProductDirectory(c.layout, 'workspaces') },
      { ...c.config.artifacts.patchPreview, maxBytes: c.config.artifacts.maxBytes }, store);
      const app = new WorkspacePatchApplication(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes);
      return await app.prepare(c.identity, source, store);
    } finally { store.close(); }
  } catch (error) { throw error instanceof ArtifactError ? ErrorRegistry.createError('PATCH_CORRUPT') : queryFailure(error); }
}
export async function previewConfiguredWorkspacePatch(root: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) {
  try {
    const c = await workspacePatchContext(root, input, options, false);
    const store = await openSqliteInventoryReader(await c.path(), { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
    try { return await new WorkspacePatchApplication(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes).preview(c.identity); }
    finally { store.close(); }
  } catch (error) { throw error instanceof ArtifactError ? ErrorRegistry.createError('PATCH_CORRUPT') : queryFailure(error); }
}
