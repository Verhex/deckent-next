import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'; import { constants } from 'node:fs'; import { open } from 'node:fs/promises';
import { prepareProductDirectory, productResourcePath, ErrorRegistry, getConfigKnownSecrets, jsonRecordDirectory, pathsShareTree, resolveLocale, type ConfigLoadOptions, type ProductLayout, type ProductResource } from '#platform/index.js';
import { attemptIdentitySchema, environmentRequirementsSchema, type AttemptIdentity } from '#domain/index.js';
import { DockerSupervisor, GitWorkspaceBroker, GitRunWorkspaceProvider, FileArtifactStore, HubArtifactCache, openSqliteHubClientStore, openSqliteAttemptStore, resolveGitWorkTarget,
  validateDockerSupervisorProfile, resolveDockerTaskProfile, dockerTaskHiddenPaths, resolveDockerReadOnlyMounts, readLocalNativeCredential, openNativeConnection, scanWorkerTree, workerTreeViews, openSqliteAuditStore, openLocalIntegrityAuthority,
  gitQueueCandidateSource, captureWorkingTreeBase, workerTreeDenied, applyAcceptedPredecessorPatches, assertSiwcWorkerLaunchable, SiwcWorkerSupervisor, siwcWorkerTurn, openWorkerEventSink, selectWorkTarget, sealAttemptWorkerEvents, nativeCodingEnvironmentProbes, nativeProjectionDispatch, type WorkerEventSealing } from '#adapters/index.js';
import { authenticate, selectedHubSkillFiles, AuditApplication, enforceAdmittedWorkerTreeGate, DispatchApplication, DispatchPolicyAuthorization, RunWorkspaceAcquisitionApplication, selectReservedTaskProfile,
  RunStoreError, DispatchError, DispatchPreparationGuard, HandoffError, recordHandoffRefusal, recordAttemptClosure, classifyLaunchRefusal, prepareTaskStart, withheldBaseStart, withheldBaseEvent, workingTreeSource, WORKER_TREE_SHOWN_PATHS, recordAttemptHandoffStart, workTargetAttemptAuthorization, assertTaskEnvironment, environmentProbeRegistry } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { parkConfiguredRunProgression } from '#composition/core/runs/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { configuredResourceCollector } from '#composition/core/resource-observation/index.js';
import { openConfiguredSiwcWorker } from '#composition/core/siwc/index.js';
import { isNativeCliWorkerProfile, resolveNativeCliWorkerProfile, inspectNativeCliWorker, prepareNativeCliWorker, validateNativeCliWorkerSupervisorProfile, nativeCliWorkerFence,
  createNativeWorkerEvents, nativeWorkerCustodyFile, type NativeCliWorkerPorts, type SqliteAttemptStore } from '#adapters/index.js';
import { createConfiguredNativeCliWorkerPorts, type NativeCliWorkerRuntime } from './native-runtime.js';
import { startConfiguredWorkerObservation } from './observation.js';
/** Lead fan-in supplies trusted transport/capacity/lease owners and enables retirement at the alpha.63 switch. Never task-authored flags. */
export type NativeCliWorkerOptions = ConfigLoadOptions & { nativeCliWorker?: Readonly<{ ports?: NativeCliWorkerPorts; runtime?: NativeCliWorkerRuntime; projectionRetired: boolean }> };
/** Execute a reserved identity using its pinned task template. The trusted project root is the
 * Git source; the command cannot supply argv, image, workspace, base commit or host paths.
 */
/** E1: park refusals meaning another transition already holds, ended or changed the Run (the timed-out refusal then stays the error). */
const HELD_PARK_SUPERSEDED: ReadonlySet<string> = new Set(['RUN_PARKED', 'RUN_TERMINAL', 'RUN_STORE_CONFLICT']);
async function nativeWorkerWaiting(projectRoot: string, identity: AttemptIdentity, layout: ProductLayout, store: Pick<SqliteAttemptStore, 'loadRun'>,
  options: ConfigLoadOptions, reason: string, legacy: boolean) {
  const current = await store.loadRun(identity.scopeId, identity.runId);
  if (current?.state.kind === 'running' && !current.cancelRequested) await parkConfiguredRunProgression(projectRoot, { schemaVersion: 1,
    scopeId: identity.scopeId, runId: identity.runId, commandId: randomUUID(), expectedRevision: current.revision, failureCode: reason }, options)
    .catch((failure: unknown) => { if (!HELD_PARK_SUPERSEDED.has(queryFailure(failure).code)) throw failure; });
  return Object.freeze({ schemaVersion: 1 as const, layout, execution: Object.freeze({ identity,
    status: 'unresolved' as const, terminal: null, outputRecorded: false, waiting: Object.freeze({ reason, legacy }) }) });
}
export async function executeConfiguredTask(projectRoot: string, input: AttemptIdentity, options: NativeCliWorkerOptions = {}) {
  try {
    const identity = attemptIdentitySchema.parse(input);
    const { config, layout, principal, path, document } = await loadConfiguredScopeContext(projectRoot, identity.scopeId, options, 'write');
    const language = resolveLocale(undefined, options.env ?? process.env, config.language); // D4: the person's report language for every worker path
    const os = userInfo(); const verifier = { async verify() { return principal; } };
    const policy = createLayoutPolicySource(layout, os.uid, config.inspection.policyMaxBytes), authorization = workTargetAttemptAuthorization(new DispatchPolicyAuthorization(policy), policy, selectWorkTarget(config.execution)?.id ?? null);
    await authorization.authorizeIdentity('execute', identity, await authenticate(verifier, undefined, identity.scopeId));
    const audit = async (event: unknown) => { const ledger = await openSqliteAuditStore(await path(), config.storage.sqlite); try { new AuditApplication(ledger, await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true)).record(event); } finally { ledger.close(); } };
    const crashes = await prepareProductDirectory(layout, 'crashes'), preparation = new DispatchPreparationGuard(jsonRecordDirectory(join(crashes, 'dispatch-preparation')), { identity, principal, policyRevision: document.revision, bound: config.runRuntime.maxPreparationAborts,
      launchers: jsonRecordDirectory(join(crashes, 'dispatch-launcher')),
      now: Date.now, record: audit, parked: async commandId => !!await store.loadRunReceipt(identity.scopeId, commandId), loadRun: () => store.loadRun(identity.scopeId, identity.runId), park: command => parkConfiguredRunProgression(projectRoot, command, options) });
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid', {
      validate: profile => profile.adapterId === 'native-cli-worker' ? validateNativeCliWorkerSupervisorProfile(profile) : validateDockerSupervisorProfile(profile) });
    // Set immediately before the dispatch application may claim; a refusal after this point is never a pre-launch refusal.
    let dispatching = false, kept = false;
    // REVISE 2695: set while the ledger holds this attempt's probe custody that no closure below may transition (only its proven end releases it).
    let custody = false;
    try {
      const existing = await store.loadBoundDispatch(identity);
      if (existing) return await preparation.settle(true).then(() => Object.freeze({ schemaVersion: 1 as const, layout, execution: Object.freeze({ identity,
        status: existing.launch === 'prevented-before-launch' ? 'prevented' : existing.terminal ? 'terminal' : 'unresolved',
        terminal: existing.terminal, outputRecorded: !!existing.output }) }));
      if (identity.layoutRevision !== layout.revision) throw new RunStoreError('RUN_STORE_CONFLICT');
      const run = await store.loadRun(identity.scopeId, identity.runId);
      const selected = selectReservedTaskProfile(run, await store.load(identity.scopeId, identity.attemptId), identity);
      const native = isNativeCliWorkerProfile(selected) ? resolveNativeCliWorkerProfile(selected) : null;
      const nativePorts = options.nativeCliWorker?.ports ?? (options.nativeCliWorker?.runtime
        ? createConfiguredNativeCliWorkerPorts(projectRoot, identity.scopeId, store, options, options.nativeCliWorker.runtime) : undefined);
      const profile = native ?? resolveDockerTaskProfile(selected), relayed = profile.siwcWorker && profile.nativeSubscription;
      const waiting = (reason: string) => nativeWorkerWaiting(projectRoot, identity, layout, store, options, reason, !native);
      // Existing dispatch replay above is deliberately outside the new-dispatch retirement/readiness gates.
      if (!native && !relayed && nativeProjectionDispatch(profile.nativeSubscription, options.nativeCliWorker?.projectionRetired === true) === 'retired') return await waiting('NATIVE_PROJECTION_RETIRED');
      if (native) {
        if (!nativePorts) return await waiting('NATIVE_AGENT_BRIDGE_UNAVAILABLE');
        const refusal = await nativePorts.prepare?.(native.binding); if (refusal) return await waiting(refusal);
        const ready = await inspectNativeCliWorker(native.binding, nativePorts);
        if (ready.state !== 'ready') return await waiting(ready.reason);
      }
      // U9-7: a relay worker passes the launch gate before any workspace, probe, connection or container; held/unprovable is a typed refusal, never another route.
      if (profile.siwcWorker) assertSiwcWorkerLaunchable({ platform: process.platform, imageCodexVersion: relayed ? relayed.preflight?.cliVersion ?? null : null });
      if (profile.options.outputFiles && profile.options.outputFiles.maxBytes > config.artifacts.maxBytes) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
      if (!config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED'); if (os.uid <= 0 || os.gid < 0) throw ErrorRegistry.createError('EXECUTION_HOST_UNSUPPORTED');
      await preparation.begin(run!); const workspaceRoot = await prepareProductDirectory(layout, 'workspaces');
      const readOnlyMounts = profile.readOnlyMounts?.length ? await resolveDockerReadOnlyMounts(projectRoot, profile.readOnlyMounts, [layout.root,
        ...(Object.keys(layout.resources) as ProductResource[]).map(resource => productResourcePath(layout, resource))]).catch(() => { throw ErrorRegistry.createError('EXECUTION_PROFILE_INVALID'); }) : undefined;
      const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(layout, 'artifacts'), maxBytes: config.artifacts.maxBytes });
      let start = await prepareTaskStart(identity, store, artifacts, verifier, authorization, config);
      const agent = run?.execution.tasks.find(task => task.taskId === identity.taskId)?.agent;
      if (agent?.skills.length) {
        const catalog = openSqliteHubClientStore(await path(), config.storage.sqlite, await openLocalIntegrityAuthority(layout, config.approvals.keyFile, false), 'read');
        try {
          const root = await prepareProductDirectory(layout, 'artifacts');
          const files = await selectedHubSkillFiles(catalog, new HubArtifactCache(HubArtifactCache.path(root), config.artifacts.maxBytes), identity.scopeId, agent);
          // H6 HOLD: Docker's readonly bind remount may clear source noexec. Do not silently omit supporting files or launch with a weaker floor.
          if (files.some(file => !file.entry)) throw ErrorRegistry.createError('HUB_SKILL_FILES_UNAVAILABLE');
        } catch (cause) { throw ErrorRegistry.createError('HUB_SKILL_FILES_UNAVAILABLE', { cause }); } finally { catalog.close(); }
      }
      const configured = { ...config.execution.git, ...(await resolveGitWorkTarget(resolve(projectRoot), config.execution, layout)).git, workspaceRoot };
      const queue = await store.loadTargetQueueVerification(identity.scopeId, identity.runId), recorded = await store.loadRunWorkspaceCustody(identity.scopeId, identity.runId);
      // R9n: a working-tree Run starts from the person's current files, committed in its own private base repository; the Run keeps the mode it began with.
      const product = [layout.root, dirname(layout.bootstrapConfigPath)].map(root => relative(configured.sourceRoot, root)).filter(path => path && !path.startsWith('..') && !isAbsolute(path));
      const base = !queue && (recorded ? workingTreeSource(recorded.source) : configured.workingTree) ? await captureWorkingTreeBase(configured, identity, { ...config.artifacts.patchPreview, maxBytes: config.artifacts.maxBytes },
        path => workerTreeDenied(path) ?? (product.some(root => path === root || path.startsWith(root + '/')) ? 'product-state' : null)) : undefined, git = base?.options ?? configured;
      if (base?.count) { await audit(withheldBaseEvent({ identity, principal, policyRevision: document.revision, now: Date.now }, base.count, base.excluded)); start = withheldBaseStart(start, base.count, base.excluded, WORKER_TREE_SHOWN_PATHS); }
      if (queue) await authorization.authorizeIdentity('read-output', queue.request.identity, principal);
      const privateSource = queue ? await gitQueueCandidateSource(queue, store, artifacts, git, { ...config.artifacts.patchPreview, maxBytes: config.artifacts.maxBytes }) : undefined;
      const broker = new GitWorkspaceBroker(git, privateSource); await preparation.enter('workspace');
      // C2: the pinned checkout shaping hides the instruction surface from a worker's clone; a queue verification Run keeps the full tree.
      const hidden = queue ? undefined : dockerTaskHiddenPaths(native?.base ?? selected) ?? undefined;
      const lease = await new RunWorkspaceAcquisitionApplication(store, new GitRunWorkspaceProvider(broker, hidden)).acquire(identity);
      const applied = await applyAcceptedPredecessorPatches(lease, git, { ...config.artifacts.patchPreview, maxBytes: config.artifacts.maxBytes }, start.patches, hidden); await preparation.enter('secret-gate');
      // S6: everything the worker receives (checkout, binds, inputs, prompt context) is scanned before any container, connection or claim, in an admitted slot (R2: identical dependency binds share the scan in flight); a refusal is audited (paths, rules) and its checkout released.
      const gate = config.execution.secretGate, lockfile = (path: string) => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).then(async file => { try { const info = await file.stat(); return info.isFile() && info.size <= gate.maxFileBytes ? await file.readFile() : null; } finally { await file.close(); } }); await enforceAdmittedWorkerTreeGate({ views: workerTreeViews(lease.workspace, readOnlyMounts, start, profile.argv), settings: gate, fingerprint: [config, git.sourceRoot], lockfile, sharesTree: pathsShareTree,
        refusals: jsonRecordDirectory(join(await prepareProductDirectory(layout, 'crashes'), 'secret-gate-time')), scan: async views => scanWorkerTree(views, { ...gate, cacheDirectory: await prepareProductDirectory(layout, 'treeScanCache'), checkoutRoot: git.sourceRoot }, getConfigKnownSecrets(config)) }, { identity, principal, policyRevision: document.revision, now: Date.now, journal: store }, audit, () => broker.release({ schemaVersion: 1, identity, baseCommit: lease.baseCommit }));
      // PRE-7: Deckent's own preflight of the declared environment on the worker's floor, without its connection (no credential, no model); an unmet
      // requirement refuses the launch typed below (the Run parks naming it) and releases the checkout, as the secret gate does.
      const request = { protocolVersion: 1 as const, identity, workspace: lease.workspace, argv: profile.argv }, release = () => broker.release({ schemaVersion: 1, identity, baseCommit: lease.baseCommit });
      if (native) {
        if (profile.environment?.requirements.length) {
          if (!nativePorts?.checkEnvironment) { await release(); return await waiting('NATIVE_AGENT_ENVIRONMENT_REFUSED'); }
          await nativePorts.checkEnvironment(request, native.binding, profile.environment,
            { ...(readOnlyMounts ? { readOnlyMounts } : {}), inputs: start.inputs, handoffInputs: start.handoffInputs }, new AbortController().signal);
        }
      } else {
      const probeOptions = { ...profile.options, executable: config.execution.docker.executable, workspaceRoot, uid: os.uid, gid: os.gid, ...(readOnlyMounts ? { readOnlyMounts } : {}) }, probe = new DockerSupervisor(probeOptions);
      // REVISE 2695: durable custody before the first probe container can start, naming every probe this attempt can start (deterministic names).
      if (profile.environment !== undefined) {
        const names: string[] = [], collect = nativeCodingEnvironmentProbes(async argv => { names.push(probe.probeIdentity(request, argv).name); return 'met' as const; });
        for (const requirement of environmentRequirementsSchema.parse(profile.environment).requirements) await collect.get(requirement.kind)?.(requirement);
        await store.holdEnvironmentProbes(identity, names); custody = true;
      }
      // A probe failure that is not an answer is gone only once its container is proven removed; otherwise it is uncertain (held), never gone.
      const ended = await assertTaskEnvironment(profile.environment, environmentProbeRegistry.with(nativeCodingEnvironmentProbes((argv, timeoutMs) => probe.probe(request, argv, timeoutMs)
        .catch(async (error: unknown) => { const { name } = probe.probeIdentity(request, argv); if (await DockerSupervisor.removePreflightProbe(probeOptions, name)) throw error; return { uncertain: name }; }))))
        .then(() => null, (error: unknown) => ({ error })), refusal = ended && classifyLaunchRefusal(ended.error), answered = refusal?.disposition === 'permanent' && refusal.requirement !== undefined;
      if (refusal?.disposition === 'permanent') await release();
      // An environment answer is projected from the custody by its closure (below); any other end of the probe path releases it here, once.
      if (custody && !answered && await store.releaseEnvironmentProbes(identity) === 'cancelled') {
        if (refusal?.disposition !== 'permanent') await release();
        return Object.freeze({ schemaVersion: 1 as const, layout, execution: Object.freeze({ identity, status: 'prevented' as const, terminal: null, outputRecorded: false }) });
      }
      custody = false; if (ended) throw ended.error;
      }
      await preparation.enter('handoff'); await recordAttemptHandoffStart(store, identity, [...start.events, ...start.patches.map(patch => ({ kind: 'workspace-started-from-patch' as const, source: patch.source, digest: patch.receipt.digest }))], applied);
      let sealing: WorkerEventSealing = Object.freeze({ status: 'nothing-to-seal' }), outcome, events: Awaited<ReturnType<typeof openWorkerEventSink>> | undefined, connection: Awaited<ReturnType<typeof openNativeConnection>> | undefined;
      let relay: Awaited<ReturnType<typeof openConfiguredSiwcWorker>> | undefined;
      let worker: Extract<Awaited<ReturnType<typeof prepareNativeCliWorker>>, { state: 'ready' }> | undefined;
      let nativeEvents: ReturnType<typeof createNativeWorkerEvents> | undefined;
      try { // D-05: the sink's file handle and the connection open inside the try whose finally closes both (Node 26 ends the service for a collected unclosed FileHandle).
      // Worker-reported events (redacted in the container, validated by the gateway) project live next to the other sidecars.
      events = profile.nativeSubscription && !relayed ? await openWorkerEventSink(dirname(lease.workspace)).catch(() => undefined) : undefined;
      if (native) nativeEvents = createNativeWorkerEvents(native.nativeSubscription!, batch => events?.accept(batch));
      // Connection follows the same authorized, pinned attempt; credential bytes never enter its receipt. A relay worker never reads a native credential.
      connection = profile.nativeSubscription && !relayed && !native ? await openNativeConnection({ binding: profile.nativeSubscription,
        directory: workspaceRoot, credential: await readLocalNativeCredential(profile.nativeSubscription.provider, options.env),
        deadlineMs: profile.options.deadlineMs, ...(profile.nativeSubscription.promptDelivery && start.dependencyContext ? { dependencyContext: start.dependencyContext } : {}), ...(events ? { onEvents: batch => events?.accept(batch) } : {}), language }) : undefined; await preparation.enter('dispatch');
      relay = relayed ? await openConfiguredSiwcWorker(projectRoot, options, { identity, principal, connection: profile.siwcWorker!, model: relayed.model!.modelId, imageId: profile.options.imageId,
        codexVersion: relayed.preflight!.cliVersion, turn: { ...siwcWorkerTurn(profile.argv, relayed.promptDelivery!, start.dependencyContext, relayed.finalReport ? language : undefined), finalReport: !!relayed.finalReport },
        deadlineMs: profile.options.deadlineMs, directory: workspaceRoot, policyRevision: document.revision, audit,
        fence: async () => { const current = await store.loadRun(identity.scopeId, identity.runId); return current?.state.kind === 'running' && !current.cancelRequested; } }) : undefined;
      const dockerOptions = { ...profile.options, executable: config.execution.docker.executable, workspaceRoot, uid: os.uid, gid: os.gid,
        ...(start.inputs.length ? { inputs: start.inputs } : {}), ...(start.handoffInputs.length ? { handoffInputs: start.handoffInputs } : {}), ...(readOnlyMounts ? { readOnlyMounts } : {}), ...(connection ? { connection: connection.descriptor } : {}) };
      if (native) {
        const prepared = await prepareNativeCliWorker({ profile: selected, request, ports: nativePorts!, custody: nativeWorkerCustodyFile(request),
          onEvents: batch => nativeEvents!.accept(batch),
          ...(start.dependencyContext ? { dependencyContext: start.dependencyContext.text } : {}), language, knownSecrets: getConfigKnownSecrets(config),
          toolContext: { ...(readOnlyMounts ? { readOnlyMounts } : {}), ...(start.inputs.length ? { inputs: start.inputs } : {}), ...(start.handoffInputs.length ? { handoffInputs: start.handoffInputs } : {}) },
          fence: () => nativeCliWorkerFence(store, identity) });
        if (prepared.state !== 'ready') { await release(); return await waiting(prepared.reason); }
        worker = prepared;
      }
      const supervisor = worker?.supervisor ?? (relay ? new SiwcWorkerSupervisor(dockerOptions, relay) : new DockerSupervisor(dockerOptions));
      const app = new DispatchApplication(store, supervisor, verifier, authorization, principal.id, artifacts, Date.now, configuredResourceCollector(config, layout));
      for (const { source } of start.declarations) await authorization.authorizeIdentity('read-output', source, principal);
      const observation = await startConfiguredWorkerObservation({ store, app, supervisor, request, backend: native ? 'native-cli-worker' : 'docker',
        provider: profile.nativeSubscription?.provider ?? 'docker', heartbeatMs: config.inspection.workers.heartbeatMs, maxFileBytes: config.inspection.workers.maxFileBytes,
        stall: run!.execution.tasks.find(row => row.taskId === identity.taskId)?.stall, gateway: connection ?? relay ?? nativeEvents });
      let result; dispatching = true;
      try { result = await app.execute(request, undefined, observation.signal); } finally { await observation.close(); }
      outcome = { status: result.kind, terminal: result.record.terminal, outputRecorded: !!result.record.output };
      if (result.kind === 'unresolved' && worker) {
        const observed = await worker.supervisor.observe(request);
        if (observed.result.kind === 'unknown') {
          const held = await waiting(observed.result.reasonCode);
          outcome = { ...outcome, waiting: held.execution.waiting };
        }
      }
      if (result.kind === 'terminal' && worker) await worker.supervisor.release(request);
      } finally {
        await connection?.close(); await relay?.close();
        await worker?.supervisor.close();
        // Seal the event log once the gateway is closed; a sealing failure never changes the execution outcome and is returned typed.
        const closedSink = await events?.close();
        // Batches refused after the gateway's budget was spent are sealed as one final loss marker (never silent).
        sealing = await sealAttemptWorkerEvents(identity, artifacts, store, { events: closedSink?.events ?? [], verification: connection?.modelVerification() ?? nativeEvents?.modelVerification() ?? null,
          unreported: connection?.statistics().eventsUnreported ?? nativeEvents?.statistics().eventsUnreported ?? 0, projectionComplete: closedSink?.projectionComplete, maxBytes: config.artifacts.maxBytes });
      }
      // Only a sealing failure is reported: the replay of a settled execution (above) keeps the same shape as a successful first call.
      return Object.freeze({ schemaVersion: 1 as const, layout, execution: Object.freeze({ identity, ...outcome, ...(sealing.status === 'failed' ? { eventLog: sealing } : {}) }) });
    } catch (error) {
      const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
      if (error instanceof HandoffError) await recordHandoffRefusal(store, identity, error, actor);
      else if (!dispatching && !custody) {
        // A permanent refusal before any dispatch claim closes the attempt once (no launch, no effect); transient ones keep the turn's backoff and (D-05) the
        // breaker record, so a process that dies after the refusal is counted at the next start in another instance (a same-instance retry counts nothing).
        const refusal = classifyLaunchRefusal(error); kept = refusal.disposition === 'transient';
        if (refusal.disposition === 'permanent' && !await store.loadBoundDispatch(identity)) await recordAttemptClosure(store, identity, { kind: 'launch-refused', code: refusal.code, ...(refusal.requirement ? { requirement: refusal.requirement } : {}), ...(refusal.probe ? { probe: refusal.probe } : {}) }, actor);
        // E1: a held refusal (no answer) holds a running Run through the existing progression park. Only a Run another transition already
        // parked, ended or changed keeps the typed refusal (the runtime's bounded failure path then parks it with the same code); any other
        // park failure (denied, store) replaces it, so no surface claims a hold that was not written.
        const run = refusal.disposition === 'held' ? await store.loadRun(identity.scopeId, identity.runId) : null;
        if (refusal.disposition === 'held' && run?.state.kind === 'running' && !run.cancelRequested) await parkConfiguredRunProgression(projectRoot, { schemaVersion: 1,
          scopeId: identity.scopeId, runId: identity.runId, commandId: randomUUID(), expectedRevision: run.revision, failureCode: refusal.code }, options)
          .catch((failure: unknown) => { if (!HELD_PARK_SUPERSEDED.has(queryFailure(failure).code)) throw failure; });
      }
      throw error;
    } finally { if (!kept) await preparation.settle(); store.close(); }
  } catch (error) { throw queryFailure(error); }
}
