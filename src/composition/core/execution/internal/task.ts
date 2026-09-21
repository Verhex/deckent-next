import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { prepareProductDirectory, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { DockerSupervisor, GitWorkspaceBroker, GitRunWorkspaceProvider, FileArtifactStore, openSqliteAttemptStore,
  validateDockerSupervisorProfile, resolveDockerTaskProfile, readLocalNativeCredential, openNativeConnection } from '#adapters/index.js';
import { authenticate, DispatchApplication, DispatchPolicyAuthorization, RunWorkspaceAcquisitionApplication, selectReservedTaskProfile, RunStoreError, DispatchError, TaskInputApplication, selectTaskInputArtifact } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Execute a reserved identity using its pinned task template. The trusted project root is the
 * Git source; the command cannot supply argv, image, workspace, base commit or host paths.
 */
export async function executeConfiguredTask(projectRoot: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) {
  try {
    const identity = attemptIdentitySchema.parse(input);
    const { config, layout, principal, path } = await loadConfiguredScopeContext(projectRoot, identity.scopeId, options);
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
      const run = await store.loadRun(identity.scopeId, identity.runId);
      const selected = selectReservedTaskProfile(run, await store.load(identity.scopeId, identity.attemptId), identity);
      const profile = resolveDockerTaskProfile(selected);
      if (profile.options.outputFiles && profile.options.outputFiles.maxBytes > config.artifacts.maxBytes) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
      if (!config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
      if (os.uid <= 0 || os.gid < 0) throw ErrorRegistry.createError('EXECUTION_HOST_UNSUPPORTED');
      const workspaceRoot = await prepareProductDirectory(layout, 'workspaces');
      const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(layout, 'artifacts'), maxBytes: config.artifacts.maxBytes });
      const inputs = [];
      const count = run?.graph.tasks.find(task => task.id === identity.taskId)?.inputs?.length ?? 0;
      if (count > config.artifacts.maxInputs) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
      const declarations = count ? await new TaskInputApplication(store, verifier, authorization).resolve(identity) : [];
      let remaining = config.artifacts.maxBytes;
      for (const { binding } of declarations) {
        if (binding.receipt.byteLength > remaining) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
        remaining -= binding.receipt.byteLength;
      }
      const selections = [];
      for (const { source, binding } of declarations) {
        const prepared = await artifacts.prepareReadOnlyFile(identity.scopeId, binding.receipt);
        const selectedInput = selectTaskInputArtifact(source, binding, prepared.bytes);
        if (binding.output) {
          if (selectedInput.receipt.byteLength > remaining) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
          remaining -= selectedInput.receipt.byteLength;
        }
        selections.push({ binding: selectedInput, envelopePath: prepared.path });
      }
      for (const { binding, envelopePath } of selections) {
        const path = binding.output ? (await artifacts.prepareReadOnlyFile(identity.scopeId, binding.receipt)).path : envelopePath;
        inputs.push({ ...binding, path });
      }
      const broker = new GitWorkspaceBroker({ ...config.execution.git, sourceRoot: resolve(projectRoot), workspaceRoot });
      const lease = await new RunWorkspaceAcquisitionApplication(store, new GitRunWorkspaceProvider(broker)).acquire(identity);
      // Connection follows the same authorized, pinned attempt; credential bytes never enter its receipt.
      const connection = profile.nativeSubscription ? await openNativeConnection({ binding: profile.nativeSubscription,
        directory: workspaceRoot, credential: await readLocalNativeCredential(profile.nativeSubscription.provider, options.env),
        deadlineMs: profile.options.deadlineMs }) : undefined;
      try {
      const supervisor = new DockerSupervisor({ ...profile.options, executable: config.execution.docker.executable, workspaceRoot, uid: os.uid, gid: os.gid,
        ...(inputs.length ? { inputs } : {}), ...(connection ? { connection: connection.descriptor } : {}) });
      const app = new DispatchApplication(store, supervisor, verifier, authorization, principal.id, artifacts);
      for (const { source } of declarations) await authorization.authorizeIdentity('read-output', source, principal);
      const result = await app.execute({ protocolVersion: 1, identity, workspace: lease.workspace, argv: profile.argv });
      return Object.freeze({ schemaVersion: 1 as const, layout, execution: Object.freeze({ identity, status: result.kind,
        terminal: result.record.terminal, outputRecorded: !!result.record.output }) });
      } finally { await connection?.close(); }
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
