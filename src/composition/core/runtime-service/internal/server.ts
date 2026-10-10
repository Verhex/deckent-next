import { withLocalPrincipalChannel } from '#adapters/index.js';
import { prepareScheduledBackup, startBackupSchedule, type BackupScheduleObserver } from '#composition/core/backup/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { executeRuntimeApproval } from './approvals.js';
import { prepareConfiguredRunRuntime, type RunProgressionObserver } from '#composition/core/run-progression/index.js';
import { RUNTIME_SERVICE_SCHEMA_VERSION, expireOrphanedToolCallApprovals, isRuntimeServiceScratchOperation, isRuntimeServiceSecretOperation, runtimeServiceErrorParams } from '#engine/index.js';
import { socketOptions } from './socket-options.js';
import { configuredServiceShutdown } from './shutdown.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { ErrorRegistry, resolveLocale, type DeckentError, inspectProductFile, ManagedFileError, readBuildIdentity, prepareProductCompanionPath, prepareProductDirectory, type ConfigLoadOptions, type TrustedClock } from '#platform/index.js';
import { acquireLocalRuntimeSocketGuard, LocalRuntimeSocketError, prepareRuntimeSocket, upgradeExistingProductLedger, validateDockerSupervisorProfile, type LedgerUpgrade,
  type LocalRuntimeSocketGuard, openSqliteAgentTurnStore, openSqliteApprovalStore, openLocalIntegrityAuthority, createScratchActivity, readTerminalScratchConfig, resolveGitWorkTarget,
  startScratchSweeper, sweepScratch, createRuntimeWorkspaceFileHost, sweepFullPreviews, type HttpFetchTransport, type ScratchSweepResult, type ShellSandboxFactory } from '#adapters/index.js';
import { ModelInvocationControllers, runtimeServiceModelOwnerId, RuntimeServiceLifecycle, classifyRuntimeServiceOperation, isRuntimeServiceEffectOperation, isRuntimeServicePermissionModeOperation, runtimeServiceDescriptorSchema, runtimeServiceDescriptionInputSchema,
  serviceInstanceSchema, ServiceShutdownError, RuntimeServiceIdlePolicy, type RuntimeServiceIdleOptions, RUNTIME_SERVICE_AUTOSTART_ENV, restartConfigDigest, type ShutdownAdmission, type RuntimeServiceDrainResult } from '#engine/index.js';
import { prepareConfiguredCancellationRuntime, prepareConfiguredReconciliationRuntime, prepareConfiguredModelCancellationRuntime,
  type ConfiguredReconciliationRuntimeObserver, type ConfiguredCancellationRuntimeObserver, type ConfiguredModelCancellationRuntimeObserver } from '#composition/core/runtime/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { releaseSettledModelSlots } from '#composition/core/model-invocation/index.js';
import { loadConfiguredInstallationIdentity, registerConfiguredScopesAtStart } from '#composition/core/scoped-request/index.js';
import { sweepConfiguredAttemptCustody } from '#composition/core/runs/index.js';
import { startToolchainRefresh, type ToolchainRefreshDependencies, type ToolchainRefreshObserver } from '#composition/core/toolchains/index.js';
import { executeConfiguredRuntimeOperation } from './operations.js';
import { executeConfiguredRuntimeModelOperation } from './model-invocation.js';
import { executeConfiguredRuntimeProviderSpendOperation } from './provider-spend.js';
import { executeConfiguredRuntimeChatTurnOperation } from './chat-turn.js';
import { createRuntimeChatTurnHost, scratchResource } from '#composition/core/agent-turn/index.js';
import { executeConfiguredRuntimeWorkspaceFileOperation } from './workspace-files.js';
import { executeConfiguredRuntimeEffectOperation } from './effect-operations.js';
import { executeConfiguredRuntimePermissionModeOperation } from './permission-mode.js';
import { executeConfiguredRuntimeSecretOperation } from './secret.js';
export interface ConfiguredRuntimeServiceObserver extends ConfiguredCancellationRuntimeObserver, ToolchainRefreshObserver, BackupScheduleObserver {
  onRunProgression?: RunProgressionObserver['onRun'];
  onRunProgressionError?: RunProgressionObserver['onError'];
  onReconciliationPage?: ConfiguredReconciliationRuntimeObserver['onPage'];
  onReconciliationError?: ConfiguredReconciliationRuntimeObserver['onError'];
  onModelCancellationPage?: ConfiguredModelCancellationRuntimeObserver['onPage'];
  onModelCancellationError?: ConfiguredModelCancellationRuntimeObserver['onError'];
  onLedgerUpgraded?(upgrade: LedgerUpgrade): void | Promise<void>;
  /** K6 = A: an automatically started service found itself idle for `afterMs` and begins its governed stop. */
  onIdleShutdown?(event: { readonly afterMs: number }): void | Promise<void>;
  /** Close turns left by a stopped service as interrupted; report damaged rows without closing them. */
  onAgentTurnsInterrupted?(result: { readonly interrupted: number; readonly corrupt: readonly { readonly scopeId: string; readonly turnId: string }[] }): void | Promise<void>;
  /** Pending tool-call approvals of turns no longer running, closed as expired at this start; `failed` counts records not verified or
   * not closed; `keyUnavailable`: the integrity key could not be opened, so nothing was closed. */
  onToolCallApprovalsExpired?(result: { readonly expired: number; readonly failed: number; readonly keyUnavailable: boolean }): void | Promise<void>;
  /** INFLIGHT-FIX/FIX-2143-SLOTS: settle ended-instance calls unknown and release settled slots; unverifiable records stay untouched. */
  onModelAllocationSlotsReleased?(result: Awaited<ReturnType<typeof releaseSettledModelSlots>>): void | Promise<void>;
  /** Scratch areas unused past retention removed at start and by the running service's periodic sweep (SCR-A S4). */
  onScratchSwept?(result: ScratchSweepResult): void | Promise<void>;
  /** EXEC-RELEASE: attempts with a verified retained patch, released or held (typed) under the same custody at start. */ onAttemptCustodySwept?(result: Awaited<ReturnType<typeof sweepConfiguredAttemptCustody>>): void | Promise<void>;
}

/** LEDGER-SINGLETON (Astra 2054 R1): backup/upgrade under ledger and endpoint custody before accepting connections. */
async function upgradeLedgerAtStart(config: Awaited<ReturnType<typeof loadComposedConfig>>, observer: ConfiguredRuntimeServiceObserver) {
  let path: string;
  try { path = await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']); }
  catch (error) { if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return; throw error; }
  const upgrade = await upgradeExistingProductLedger(path, config.storage.sqlite, await prepareProductDirectory(config.productLayout, 'ledgerBackups'),
    new Date(), { validate: validateDockerSupervisorProfile }, config.company.id);
  if (upgrade) await observer.onLedgerUpgraded?.(upgrade);
}

/** Interrupt abandoned turns only under ledger custody; a second start cannot close a live service's turns. */
async function interruptAgentTurnsAtStart(config: Awaited<ReturnType<typeof loadComposedConfig>>, observer: ConfiguredRuntimeServiceObserver, custodyId: string, options: ConfigLoadOptions) {
  let path: string;
  try { path = await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']); }
  catch (error) { if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return; throw error; }
  const store = await openSqliteAgentTurnStore(path, config.storage.sqlite, 'forbid');
  try {
    const result = await store.interruptRunning(Date.now(), resolveLocale(undefined, options.env ?? process.env, config.language));
    if (result.interrupted || result.corrupt.length) await observer.onAgentTurnsInterrupted?.(result);
  } finally { store.close(); }
  // FIX-2143-SLOTS/INFLIGHT-FIX (Astra 2145 R1): settle this custody's abandoned calls and release settled slots; leave other open calls intact.
  const slots = await releaseSettledModelSlots(path, config.storage.sqlite, custodyId);
  if (slots.released || slots.settled || slots.inconsistent.length || slots.spend.released || slots.spend.inconsistent.length) await observer.onModelAllocationSlotsReleased?.(slots);
  // Previews kept for approvals that were pending when the service stopped (none survives a restart).
  await sweepFullPreviews(config.productLayout);
  // Their tool-call approvals can no longer permit anything: still-pending ones (a crash, or a close that failed) are closed now.
  const approvals = openSqliteApprovalStore(path, config.storage.sqlite);
  try {
    if (!approvals.store.pendingToolCalls(null, 1).length) return;
    // The key already exists when such a request exists; a missing key is reported, never created here.
    const integrity = await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile).catch(() => null);
    // The sweep runs whether or not anyone observes it (Astra 2096 R1); the observer only reports its result.
    const result = integrity ? { ...expireOrphanedToolCallApprovals(approvals.store, integrity, config.approvals.pageSize), keyUnavailable: false }
      : { expired: 0, failed: 0, keyUnavailable: true };
    await observer.onToolCallApprovalsExpired?.(result);
  } finally { approvals.close(); }
}

/** Explicit local host. Only durable authorized shutdown intent may turn client completion into host shutdown. */
async function startService(projectRoot: string, observer: ConfiguredRuntimeServiceObserver,
  options: ConfigLoadOptions = {}, ports: RuntimeServicePorts = {}) {
  await loadConfiguredInstallationIdentity(projectRoot, options);
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false });
  // Name every missing section: an absent config.json lacks both, and the catalog text interpolates `{missing}`.
  const missingCancellation = [...(config.cancellation ? [] : ['cancellation']), ...(config.cancellationRuntime ? [] : ['cancellationRuntime'])];
  if (missingCancellation.length) throw ErrorRegistry.createError('CANCELLATION_NOT_CONFIGURED', { params: { missing: missingCancellation.join(', ') } });
  await resolveGitWorkTarget(projectRoot, config.execution, config.productLayout); // WORK-TARGETS: typed refusal before any custody or write
  const endpoint = await prepareRuntimeSocket(config.productLayout);
  // LEDGER-SINGLETON (Astra 2054 R1): acquire ledger then endpoint custody before upgrade; hold through listener start.
  const guard = await acquireLocalRuntimeSocketGuard(socketOptions(config.service, endpoint), await prepareProductCompanionPath(config.productLayout, 'ledger', '-lock'));
  try { return await startUnderCustody(projectRoot, observer, options, config, guard, ports); }
  catch (error) { await guard.release(); throw error; }
}

async function startUnderCustody(projectRoot: string, observer: ConfiguredRuntimeServiceObserver, options: ConfigLoadOptions,
  config: Awaited<ReturnType<typeof loadComposedConfig>>, guard: LocalRuntimeSocketGuard, ports: RuntimeServicePorts) {
  await prepareScheduledBackup(projectRoot, options, observer);
  await upgradeLedgerAtStart(config, observer);
  // H34 S1: the configured company and the installation's own scopes are registered under the same custody (first start).
  const scopes = await registerConfiguredScopesAtStart(config);
  await interruptAgentTurnsAtStart(config, observer, guard.custodyId, options);
  const custody = await sweepConfiguredAttemptCustody(projectRoot, [...scopes?.pins.keys() ?? []], options); if (custody.length) await observer.onAttemptCustodySwept?.(custody);
  // SCR-A S4: under the same custody, scratch areas unused past retention (a restart leaves no turn running, so none is held). The one
  // scratch custody of this service: start sweep, periodic sweep and turns claim and hold areas through it (Astra 2149).
  const scratchRoot = await scratchResource(config.productLayout), scratchLimits = readTerminalScratchConfig(config as unknown as Record<string, unknown>);
  const scratchActivity = createScratchActivity();
  const swept = scratchRoot ? await sweepScratch(scratchRoot, scratchLimits, Date.now(), scratchActivity) : null;
  if (swept && (swept.removedSessions || swept.unreadable)) await observer.onScratchSwept?.(swept);
  const preparedRecovery = await prepareConfiguredCancellationRuntime(projectRoot, observer, options);
  const preparedReconciliation = config.reconciliationRuntime ? await prepareConfiguredReconciliationRuntime(projectRoot, {
    onPage: (command, result) => observer.onReconciliationPage?.(command, result),
    onError: (command, error) => observer.onReconciliationError?.(command, error),
  }, options) : null;
  const instanceId = randomUUID();
  // The send owner names this instance and the custody it holds: only a later start holding that custody proves its open calls ended.
  const modelHost = { ownerId: runtimeServiceModelOwnerId(guard.custodyId, instanceId), controllers: new ModelInvocationControllers(config.service.maxConcurrentExecutions),
    ...(ports.modelInvocationClock ? { clock: ports.modelInvocationClock } : {}) };
  // Service stop cancels running turns (they close as cancelled, not interrupted).
  const turnStop = new AbortController();
  const chatTurnHost = createRuntimeChatTurnHost(modelHost, turnStop.signal, scratchActivity, ports.fetchTransport, ports.shellSandboxes, config.mcp.maxServers);
  const workspaceFiles = createRuntimeWorkspaceFileHost();
  const preparedModelCancellation = await prepareConfiguredModelCancellationRuntime(projectRoot, modelHost.controllers, {
    onPage: (command, result) => observer.onModelCancellationPage?.(command, result),
    onError: (command, error) => observer.onModelCancellationError?.(command, error),
  }, options);
  const build = readBuildIdentity();
  // K6 = A: only a service the terminal started itself (launch marker) ever stops by idleness; a hand- or config-started one never does.
  const autoStarted = options.env?.[RUNTIME_SERVICE_AUTOSTART_ENV] === '1';
  const idle = new RuntimeServiceIdlePolicy({ autoStarted, afterMs: config.service.idleShutdown.afterMs, now: ports.idleClock?.now ?? (() => performance.now()),
    wait: ports.idleClock?.wait ?? (async (milliseconds, signal) => { try { await wait(milliseconds, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; } }) });
  const descriptor = runtimeServiceDescriptorSchema.parse({ schemaVersion: 1, instanceId, configDigest: restartConfigDigest(config as unknown as Record<string, unknown>),
    autoStarted, idleStopMs: idle.enabled ? config.service.idleShutdown.afterMs : null,
    shutdownAvailable: config.service.identity !== null, identity: config.service.identity, processId: process.pid,
    ...(build ? { build: { sourceTreeSha256: build.sourceTreeSha256, sourceCommit: build.sourceCommit } } : {}) });
  const shutdown = config.service.identity ? configuredServiceShutdown(config,
    serviceInstanceSchema.parse({ ...config.service.identity, instanceId })) : null;
  const remoteShutdowns = new Map<string, Promise<void>>();
  const controller = new AbortController();
  let recovery: Promise<void> = Promise.resolve();
  // WORKER-AUTO-REFRESH: the background refresh started below; a stop waits for it (its build is ended by the controller's signal) so no
  // refresh write lands after this service released its custody.
  let toolchainRefresh: Promise<void> = Promise.resolve();
  let backupSchedule: Promise<void> = Promise.resolve();
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: config.service.maxConcurrentRequests, maxConcurrentExecutions: config.service.maxConcurrentExecutions, admissionWaitMs: config.service.admissionWaitMs }, () => {
    // A scratch removal in flight, every MCP server the turns started (stdin closed, then SIGTERM/SIGKILL) and a toolchain refresh in flight
    // end before the endpoint and ledger custody are released (finalize runs after this settles).
    controller.abort(); turnStop.abort();
    return Promise.allSettled([recovery, scratchActivity.close(), chatTurnHost.mcp.close(), toolchainRefresh, backupSchedule]).then(([settled]) => { if (settled.status === 'rejected') throw settled.reason; });
  }, {
    async wait(milliseconds, signal) { try { await wait(milliseconds, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; } },
  });
  const preparedRunRuntime = await prepareConfiguredRunRuntime(projectRoot, {
    ...(observer.onRunProgression ? { onRun: observer.onRunProgression } : {}),
    ...(observer.onRunProgressionError ? { onError: observer.onRunProgressionError, onScopeSkipped: (note: DeckentError) => observer.onRunProgressionError?.(null, note) } : {}),
  }, (work, onSlotWait) => lifecycle.admitExecution(() => idle.track(work), onSlotWait), options);
  const server = await guard.start((request, peer, stream, turn) => withLocalPrincipalChannel(request.channel, () => idle.track(async () => {
    try {
      if (request.operation === 'describeService') {
        const result = await lifecycle.admitBounded(() => { runtimeServiceDescriptionInputSchema.parse(request.input); return descriptor; });
        return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result };
      }
      if (request.operation === 'shutdownService') {
        if (!shutdown) throw new ServiceShutdownError('SERVICE_SHUTDOWN_INVALID');
        const result = await lifecycle.admitBounded(() => shutdown.admit(request.input, peer));
        return { response: { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result },
          afterResponseOrDisconnect: () => finishRemoteShutdown(result.admission) };
      }
      const result = await lifecycle.admitBounded(() => request.operation === 'renewApproval' || request.operation === 'listApprovals' || request.operation === 'inspectApproval' || request.operation === 'decideApproval' || request.operation === 'clearSessionStanding'
        ? executeRuntimeApproval(projectRoot, request, peer, config.service.responseMaxBytes, options, chatTurnHost.decisions, chatTurnHost.answers)
        : request.operation === 'inspectProviderSpendAccount' || request.operation === 'auditProviderSpendAccount' || request.operation === 'manageProviderSpend'
        ? executeConfiguredRuntimeProviderSpendOperation(projectRoot, request, peer, config.service.responseMaxBytes, options)
        : request.operation === 'invokeModel' || request.operation === 'invokeModelStream' || request.operation === 'inspectModelInvocation' || request.operation === 'purgeModelInvocationContent' || request.operation === 'cancelModelInvocation'
          ? executeConfiguredRuntimeModelOperation(projectRoot, request, peer, config.service.responseMaxBytes, options, modelHost, stream)
          : request.operation === 'chatTurn' || request.operation === 'cancelChatTurn'
          ? executeConfiguredRuntimeChatTurnOperation(projectRoot, request, peer, config.service.responseMaxBytes, options, chatTurnHost, turn)
          : request.operation === 'findWorkspaceFiles' || request.operation === 'attachWorkspaceFile' || isRuntimeServiceScratchOperation(request.operation)
          ? executeConfiguredRuntimeWorkspaceFileOperation(projectRoot, request, peer, config.service.responseMaxBytes, options, workspaceFiles, turnStop.signal)
          : isRuntimeServiceEffectOperation(request.operation)
          ? executeConfiguredRuntimeEffectOperation(projectRoot, request, peer, config.service.responseMaxBytes, options)
          : isRuntimeServicePermissionModeOperation(request.operation)
          ? executeConfiguredRuntimePermissionModeOperation(projectRoot, request, peer, config.service.responseMaxBytes, options)
          : isRuntimeServiceSecretOperation(request.operation)
          ? executeConfiguredRuntimeSecretOperation(projectRoot, request, peer, config.service.responseMaxBytes, options)
          : executeConfiguredRuntimeOperation(projectRoot, request, options), classifyRuntimeServiceOperation(request.operation));
      return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result };
    } catch (error) {
      const failure = queryFailure(error);
      const params = runtimeServiceErrorParams(failure.params);
      return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: false,
        error: { code: failure.code, category: failure.category, ...(params ? { params } : {}) } };
    }
  }), peer));
  // Started once the listener is up: a start that fails before leaves no sweep running after its custody is released.
  startScratchSweeper({ root: () => scratchResource(config.productLayout), limits: scratchLimits, active: scratchActivity, signal: turnStop.signal,
    onSweep: result => { void observer.onScratchSwept?.(result); } });
  // WORKER-AUTO-REFRESH: never awaited by readiness; the controller's signal ends its interval timer and a running build when the service
  // stops, and the stop waits for what is left (above).
  backupSchedule = startBackupSchedule(projectRoot, options, controller.signal, observer);
  toolchainRefresh = startToolchainRefresh(projectRoot, options, observer, controller.signal, ports.toolchainRefresh).done;
  let resolveDone!: () => void; let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => undefined);
  let stopping: Promise<RuntimeServiceDrainResult> | null = null;
  let transportFailure: ReturnType<typeof queryFailure> | null = null;
  const stop = () => {
    if (stopping) return stopping;
    server.stopAccepting();
    stopping = lifecycle.stop(config.service.shutdownGraceMs, () => server.dispose()).then(result => {
      // Drop transport clients at the same deadline without aborting their admitted worker operations.
      if (result.state === 'incomplete') {
        server.disconnectClients();
        // Fatal transport has no signal caller to observe stop()'s deadline result.
        // Release the foreground host with an honest incomplete outcome, not an unbounded done wait.
        if (transportFailure) rejectDone(queryFailure(ErrorRegistry.createError('RUNTIME_SERVICE_SHUTDOWN_INCOMPLETE')));
      }
      return result;
    });
    // Finalization shares the grace deadline. The guard remains until admitted work and recovery settle.
    void lifecycle.whenSettled().then(async () => {
      await Promise.all(remoteShutdowns.values());
      if (transportFailure) throw transportFailure;
      resolveDone();
    }).catch(error => rejectDone(queryFailure(error)));
    return stopping;
  };
  const finishRemoteShutdown = (admission: ShutdownAdmission) => {
    if (!shutdown || remoteShutdowns.has(admission.command.commandId)) return;
    // Register completion before stop starts. Host done must not outrun durable outcome publication.
    const completion = Promise.resolve().then(async () => {
      const result = await stop();
      await shutdown.recordOutcome(admission, result);
      if (result.state === 'incomplete') throw ErrorRegistry.createError('RUNTIME_SERVICE_SHUTDOWN_INCOMPLETE');
    });
    remoteShutdowns.set(admission.command.commandId, completion);
    void completion.catch(error => rejectDone(queryFailure(error)));
  };
  void server.termination.then(event => {
    if (event.reason !== 'requested') {
      transportFailure = queryFailure(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT'));
      void stop().catch(error => rejectDone(queryFailure(error)));
    }
  });
  const hostedRecovery = [
    preparedRunRuntime.run(controller.signal),
    preparedRecovery.run(controller.signal),
    preparedModelCancellation.run(controller.signal),
    ...(preparedReconciliation ? [preparedReconciliation.run(controller.signal)] : []),
  ];
  recovery = Promise.allSettled(hostedRecovery.map(work => work.catch(error => {
    controller.abort(); void stop().catch(() => undefined); throw error;
  }))).then(results => {
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });
  void recovery.catch(() => { void stop().catch(() => undefined); });
  // The idle stop is the ordinary governed stop (it waits recovery, the toolchain refresh and the scratch work); it records no shutdown admission.
  if (idle.enabled) void idle.run(controller.signal).then(async outcome => {
    if (outcome !== 'idle') return;
    await observer.onIdleShutdown?.({ afterMs: config.service.idleShutdown.afterMs! });
    await stop();
  }).catch(error => rejectDone(queryFailure(error)));
  return Object.freeze({ endpoint: server.endpoint, layout: config.productLayout, done, stop });
}

/** Code-only ports of an in-process service (never configuration or environment): `fetchTransport` defaults to the system transport,
 * `shellSandboxes` to the shipped sandbox providers (S9 bubblewrap). */
export interface RuntimeServicePorts { readonly fetchTransport?: HttpFetchTransport; readonly shellSandboxes?: ShellSandboxFactory; readonly toolchainRefresh?: ToolchainRefreshDependencies;
  /** One trusted clock for model tariff freshness, quote/send validation and durable invocation times (default: SystemTrustedClock). */
  readonly modelInvocationClock?: TrustedClock;
  /** Clock and wait of the idle stop (default: monotonic clock and timer). */
  readonly idleClock?: Pick<RuntimeServiceIdleOptions, 'now' | 'wait'> }
export async function startConfiguredRuntimeService(projectRoot: string, observer: ConfiguredRuntimeServiceObserver,
  options: ConfigLoadOptions = {}, ports: RuntimeServicePorts = {}) {
  try { return await startService(projectRoot, observer, options, ports); }
  catch (error) { throw queryFailure(error); }
}
