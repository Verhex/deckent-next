import { ArtifactError } from '#capabilities/index.js';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { ErrorRegistry, inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { dockerTaskHiddenPaths, FileArtifactStore, GitWorkspaceBroker, GitWorkspacePatchSource, openSqliteAttemptStore, openSqliteInventoryReader, resolveGitWorkTarget, selectWorkTarget, validateDockerSupervisorProfile, gitDockerAttemptCustody } from '#adapters/index.js';
import { AttemptCustodyReleaseApplication, assertSameWorkSource, DispatchPolicyAuthorization, WorkspacePatchApplication, workTargetAttemptAuthorization, type ScopeAccess } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
export async function workspacePatchContext(root: string, input: unknown, options: ConfigLoadOptions, preparing: boolean, access: ScopeAccess, readsTarget = true) {
  const identity = attemptIdentitySchema.parse(input), context = await loadConfiguredScopeContext(root, identity.scopeId, options, access);
  const { config, layout, principal } = context, policy = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes), authorization = workTargetAttemptAuthorization(new DispatchPolicyAuthorization(policy), policy, selectWorkTarget(config.execution)?.id ?? null, readsTarget);
  await authorization.authorizeIdentity('read-output', identity, principal);
  if (preparing) await authorization.authorizeIdentity('recover-output', identity, principal);
  const artifacts = new FileArtifactStore({ root: await inspectProductDirectory(layout, 'artifacts'), maxBytes: config.artifacts.maxBytes });
  // BeUser DR2-05: integration, delivery and adoption act where this Run's work was made; another current work source is WORK_TARGET_CHANGED naming both.
  const sameWorkSource = async (store: { loadRunWorkspaceCustody(scopeId: string, runId: string): Promise<{ readonly source: { readonly sourceFingerprint: string } } | null> }) => {
    const execution = config.execution;
    if (!execution) return;
    const workspaceRoot = await inspectProductDirectory(layout, 'workspaces');
    const recorded = (await store.loadRunWorkspaceCustody(identity.scopeId, identity.runId))?.source.sourceFingerprint;
    const now = (await resolveGitWorkTarget(resolve(root), execution, layout)).git.sourceRoot;
    const fingerprint = (sourceRoot: string) => new GitWorkspaceBroker({ ...execution.git, sourceRoot, workspaceRoot }).captureSourceBase().then(base => base.sourceFingerprint);
    await assertSameWorkSource(recorded, { now, project: resolve(root) }, fingerprint);
  };
  return { ...context, identity, artifacts, authorization, sameWorkSource, verifier: { async verify() { return principal; } }, scopeMode: selectWorkTarget(config.execution)?.scope?.mode ?? 'warn' };
}
async function preparePatch(root: string, input: AttemptIdentity, options: ConfigLoadOptions, release: boolean) {
  try {
    const c = await workspacePatchContext(root, input, options, true, 'write'), execution = c.config.execution;
    if (!execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, { now: Date.now, timeoutMs: c.config.runRuntime.parking.timeoutMs }, 'forbid', { validate: validateDockerSupervisorProfile });
    try {
      const git = { ...execution.git, ...(await resolveGitWorkTarget(resolve(root), execution, c.layout)).git, workspaceRoot: await inspectProductDirectory(c.layout, 'workspaces') };
      // C2: the attempt's pinned checkout shaping comes from the Run's frozen task profile, never from a file beside the checkout.
      const hidden = async (attempt: AttemptIdentity) => { const task = (await store.loadRun(attempt.scopeId, attempt.runId))?.execution.tasks.find(row => row.taskId === attempt.taskId); return task ? dockerTaskHiddenPaths(task.profile) : null; };
      const source = new GitWorkspacePatchSource(git, { ...c.config.artifacts.patchPreview, maxBytes: c.config.artifacts.maxBytes }, store, hidden);
      const custody = new AttemptCustodyReleaseApplication({ store, artifacts: c.artifacts, verifier: c.verifier, authorization: c.authorization, owner: c.principal.id, retention: execution.retention, ...gitDockerAttemptCustody(git) });
      const app = new WorkspacePatchApplication(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes, c.scopeMode, release ? custody : undefined);
      return await app.prepare(c.identity, source, store);
    } finally { store.close(); }
  } catch (error) { throw error instanceof ArtifactError ? ErrorRegistry.createError('PATCH_CORRUPT') : queryFailure(error); }
}
export async function previewConfiguredWorkspacePatch(root: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) {
  try {
    const c = await workspacePatchContext(root, input, options, false, 'read', false);
    const store = await openSqliteInventoryReader(await c.path(), { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
    try { return await new WorkspacePatchApplication(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes, c.scopeMode).preview(c.identity); }
    finally { store.close(); }
  } catch (error) { throw error instanceof ArtifactError ? ErrorRegistry.createError('PATCH_CORRUPT') : queryFailure(error); }
}
export const prepareConfiguredWorkspacePatch = (root: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) => preparePatch(root, input, options, true);
/** Evaluation prepares the delivery patch without releasing execution custody. */
export const prepareConfiguredEvaluationPatch = (root: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) => preparePatch(root, input, options, false);
