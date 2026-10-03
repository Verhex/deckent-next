import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { prepareProductDirectory, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { DockerSupervisor, GitWorkspaceBroker, GitRunWorkspaceProvider, FileArtifactStore, openSqliteAttemptStore, resolveGitWorkTarget,
  validateDockerSupervisorProfile, resolveDockerTaskProfile, resolveDockerReadOnlyMounts, readLocalNativeCredential, openNativeConnection,
  applyAcceptedPredecessorPatches, startWorkerObservation, openWorkerEventSink, sealWorkerEventLog, selectWorkTarget } from '#adapters/index.js';
import { authenticate, DispatchApplication, DispatchPolicyAuthorization, RunWorkspaceAcquisitionApplication, selectReservedTaskProfile,
  RunStoreError, DispatchError, HandoffError, recordHandoffRefusal, prepareTaskStart, recordAttemptHandoffStart, workTargetAttemptAuthorization } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Execute a reserved identity using its pinned task template. The trusted project root is the
 * Git source; the command cannot supply argv, image, workspace, base commit or host paths.
 */
export async function executeConfiguredTask(projectRoot: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) {
  try {
    const identity = attemptIdentitySchema.parse(input);
    const { config, layout, principal, path } = await loadConfiguredScopeContext(projectRoot, identity.scopeId, options, 'write');
    const os = userInfo(); const verifier = { async verify() { return principal; } };
    const policy = createLayoutPolicySource(layout, os.uid, config.inspection.policyMaxBytes), authorization = workTargetAttemptAuthorization(new DispatchPolicyAuthorization(policy), policy, selectWorkTarget(config.execution)?.id ?? null);
    await authorization.authorizeIdentity('execute', identity, await authenticate(verifier, undefined, identity.scopeId));
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid', { validate: validateDockerSupervisorProfile });

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
      const readOnlyMounts = profile.readOnlyMounts?.length ? await resolveDockerReadOnlyMounts(projectRoot, profile.readOnlyMounts, [layout.root,
        ...Object.values(layout.resources)]).catch(() => { throw ErrorRegistry.createError('EXECUTION_PROFILE_INVALID'); }) : undefined;
      const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(layout, 'artifacts'), maxBytes: config.artifacts.maxBytes });
      const start = await prepareTaskStart(identity, store, artifacts, verifier, authorization, config);
      const git = { ...config.execution.git, ...(await resolveGitWorkTarget(resolve(projectRoot), config.execution, layout)).git, workspaceRoot };
      const broker = new GitWorkspaceBroker(git);
      const lease = await new RunWorkspaceAcquisitionApplication(store, new GitRunWorkspaceProvider(broker)).acquire(identity);
      await applyAcceptedPredecessorPatches(lease, git, { ...config.artifacts.patchPreview, maxBytes: config.artifacts.maxBytes }, start.patches);
      await recordAttemptHandoffStart(store, identity, [...start.events, ...start.patches.map(patch => ({ kind: 'workspace-started-from-patch' as const, source: patch.source, digest: patch.receipt.digest }))]);
      // Worker-reported events (redacted in the container, validated by the gateway) project live next to the other sidecars.
      const events = profile.nativeSubscription ? await openWorkerEventSink(dirname(lease.workspace)).catch(() => undefined) : undefined;
      // Connection follows the same authorized, pinned attempt; credential bytes never enter its receipt.
      const connection = profile.nativeSubscription ? await openNativeConnection({ binding: profile.nativeSubscription,
        directory: workspaceRoot, credential: await readLocalNativeCredential(profile.nativeSubscription.provider, options.env),
        deadlineMs: profile.options.deadlineMs, ...(profile.nativeSubscription.promptDelivery && start.dependencyContext ? { dependencyContext: start.dependencyContext } : {}), ...(events ? { onEvents: batch => events.accept(batch) } : {}) }) : undefined;
      try {
      const supervisor = new DockerSupervisor({ ...profile.options, executable: config.execution.docker.executable, workspaceRoot, uid: os.uid, gid: os.gid,
        ...(start.inputs.length ? { inputs: start.inputs } : {}), ...(start.handoffInputs.length ? { handoffInputs: start.handoffInputs } : {}), ...(readOnlyMounts ? { readOnlyMounts } : {}), ...(connection ? { connection: connection.descriptor } : {}) });
      const app = new DispatchApplication(store, supervisor, verifier, authorization, principal.id, artifacts);
      for (const { source } of start.declarations) await authorization.authorizeIdentity('read-output', source, principal);
      const request = { protocolVersion: 1 as const, identity, workspace: lease.workspace, argv: profile.argv };
      const observation = await startWorkerObservation(dirname(lease.workspace), config.inspection.workers.heartbeatMs,
        config.inspection.workers.maxFileBytes, async () => {
          const record = await store.loadBoundDispatch(identity); if (!record) return null;
          const activity = await supervisor.inspectActivity(request).catch(() => ({ handle: null, state: 'unknown' as const }));
          return { schemaVersion: 1, identity, backend: 'docker', provider: profile.nativeSubscription?.provider ?? 'docker',
            workspace: lease.workspace, observedAt: Date.now(), process: activity.state, handle: activity.handle,
            terminal: record.terminal, outputRecorded: !!record.output };
        });
      let result;
      try { result = await app.execute(request); } finally { await observation.close(); }
      return Object.freeze({ schemaVersion: 1 as const, layout, execution: Object.freeze({ identity, status: result.kind,
        terminal: result.record.terminal, outputRecorded: !!result.record.output }) });
      } finally {
        await connection?.close();
        // Seal the event log once the gateway is closed; retention failure never changes the execution outcome.
        const closedSink = await events?.close();
        // Batches refused after the gateway's budget was spent are sealed as one final loss marker (never silent).
        const unreported = connection?.statistics().eventsUnreported ?? 0;
        const verification = connection?.modelVerification() ?? null;
        try {
          // Keep the events that fit the artifact limit; the loss stays visible as a byte-cap marker, never silent.
          const lines = sealWorkerEventLog(closedSink?.events ?? [], verification, unreported, config.artifacts.maxBytes);
          if (lines.length) {
            const receipt = await artifacts.put(identity.scopeId, Buffer.from(lines.join('')));
            await store.saveWorkerEventLog({ schemaVersion: 1, identity, events: receipt, eventCount: lines.length, sealedAt: Date.now(),
              projection: closedSink?.projectionComplete === false ? 'partial' : 'complete' });
          }
        } catch { /* live sidecar remains; sealing is observation, not execution */ }
      }
    } catch (error) {
      if (error instanceof HandoffError) await recordHandoffRefusal(store, identity, error, { id: principal.id, issuer: principal.issuer, subject: principal.subject });
      throw error;
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
