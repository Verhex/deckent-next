import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { prepareProductDirectory, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { DockerSupervisor, GitWorkspaceBroker, GitRunWorkspaceProvider, FileArtifactStore, openSqliteAttemptStore,
  validateDockerSupervisorProfile, resolveDockerTaskProfile } from '#adapters/index.js';
import { authenticate, DispatchApplication, DispatchPolicyAuthorization, RunWorkspaceAcquisitionApplication, selectReservedTaskProfile, RunStoreError } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredRunContext } from '#composition/core/runs/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Execute a reserved identity using its pinned task template. The trusted project root is the
 * Git source; the command cannot supply argv, image, workspace, base commit or host paths.
 */
export async function executeConfiguredTask(projectRoot: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) {
  try {
    const identity = attemptIdentitySchema.parse(input);
    const { config, layout, principal, path } = await loadConfiguredRunContext(projectRoot, identity.scopeId, options);
    const os = userInfo(); const verifier = { async verify() { return principal; } };
    const authorization = new DispatchPolicyAuthorization(createLayoutPolicySource(layout, os.uid, config.inspection.policyMaxBytes));
    await authorization.authorizeIdentity('execute', identity, await authenticate(verifier, undefined, identity.scopeId));
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid', { validate: validateDockerSupervisorProfile });
    try {
      const existing = await store.loadBoundDispatch(identity);
      if (existing) return Object.freeze({ schemaVersion: 1 as const, layout, execution: Object.freeze({ identity,
        status: existing.launch === 'prevented-before-launch' ? 'prevented' : existing.terminal ? 'terminal' : 'unresolved',
        terminal: existing.terminal, outputRecorded: !!existing.output }) });
      if (identity.layoutRevision !== layout.revision) throw new RunStoreError('RUN_STORE_CONFLICT');
      const selected = selectReservedTaskProfile(await store.loadRun(identity.scopeId, identity.runId), await store.load(identity.scopeId, identity.attemptId), identity);
      const profile = resolveDockerTaskProfile(selected);
      if (!config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
      if (os.uid <= 0 || os.gid < 0) throw ErrorRegistry.createError('EXECUTION_HOST_UNSUPPORTED');
      const workspaceRoot = await prepareProductDirectory(layout, 'workspaces');
      const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(layout, 'artifacts'), maxBytes: config.artifacts.maxBytes });
      const broker = new GitWorkspaceBroker({ ...config.execution.git, sourceRoot: resolve(projectRoot), workspaceRoot });
      const lease = await new RunWorkspaceAcquisitionApplication(store, new GitRunWorkspaceProvider(broker)).acquire(identity);
      const supervisor = new DockerSupervisor({ ...profile.options, executable: config.execution.docker.executable, workspaceRoot, uid: os.uid, gid: os.gid });
      const app = new DispatchApplication(store, supervisor, verifier, authorization, principal.id, artifacts);
      const result = await app.execute({ protocolVersion: 1, identity, workspace: lease.workspace, argv: profile.argv });
      return Object.freeze({ schemaVersion: 1 as const, layout, execution: Object.freeze({ identity, status: result.kind,
        terminal: result.record.terminal, outputRecorded: !!result.record.output }) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
