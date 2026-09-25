import { executeRuntimeApproval } from './approvals.js';
import { prepareConfiguredRunRuntime, type RunProgressionObserver } from '#composition/core/run-progression/index.js';
import { RUNTIME_SERVICE_SCHEMA_VERSION, runtimeServiceErrorParams } from '#engine/index.js';
import { socketOptions } from './socket-options.js';
import { configuredServiceShutdown } from './shutdown.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { ErrorRegistry, inspectProductFile, loadConfig, ManagedFileError, readBuildIdentity, prepareProductDirectory, prepareProductSocket, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, acquireLocalRuntimeSocketGuard, LocalRuntimeSocketError, upgradeExistingProductLedger, validateDockerSupervisorProfile, type LedgerUpgrade,
  type LocalRuntimeSocketGuard, openSqliteAgentTurnStore } from '#adapters/index.js';
import { ModelInvocationControllers, RuntimeServiceLifecycle, classifyRuntimeServiceOperation, runtimeServiceDescriptorSchema, runtimeServiceDescriptionInputSchema,
  serviceInstanceSchema, ServiceShutdownError, type ShutdownAdmission, type RuntimeServiceDrainResult } from '#engine/index.js';
import { prepareConfiguredCancellationRuntime, prepareConfiguredReconciliationRuntime, type ConfiguredReconciliationRuntimeObserver, type ConfiguredCancellationRuntimeObserver } from '#composition/core/runtime/index.js';
import { prepareConfiguredModelCancellationRuntime, type ConfiguredModelCancellationRuntimeObserver } from '#composition/core/runtime/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { executeConfiguredRuntimeOperation } from './operations.js';
import { executeConfiguredRuntimeModelOperation } from './model-invocation.js';
import { executeConfiguredRuntimeProviderSpendOperation } from './provider-spend.js';
import { executeConfiguredRuntimeChatTurnOperation } from './chat-turn.js';
import { createRuntimeChatTurnHost } from '#composition/core/agent-turn/index.js';

export interface ConfiguredRuntimeServiceObserver extends ConfiguredCancellationRuntimeObserver {
  onRunProgression?: RunProgressionObserver['onRun'];
  onRunProgressionError?: RunProgressionObserver['onError'];
  onReconciliationPage?: ConfiguredReconciliationRuntimeObserver['onPage'];
  onReconciliationError?: ConfiguredReconciliationRuntimeObserver['onError'];
  onModelCancellationPage?: ConfiguredModelCancellationRuntimeObserver['onPage'];
  onModelCancellationError?: ConfiguredModelCancellationRuntimeObserver['onError'];
  onLedgerUpgraded?(upgrade: LedgerUpgrade): void | Promise<void>;
  /** Turns a stopped service left running, closed as interrupted at this start; damaged rows are reported, not closed. */
  onAgentTurnsInterrupted?(result: { readonly interrupted: number; readonly corrupt: readonly { readonly scopeId: string; readonly turnId: string }[] }): void | Promise<void>;
}

/** An existing older ledger is backed up and migrated once, under endpoint custody and before the service accepts
 * connections (Jev 8bb2a0c7, Astra 2054 R1). */
async function upgradeLedgerAtStart(config: Awaited<ReturnType<typeof loadConfig>>, observer: ConfiguredRuntimeServiceObserver) {
  let path: string;
  try { path = await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']); }
  catch (error) { if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return; throw error; }
  const upgrade = await upgradeExistingProductLedger(path, config.storage.sqlite, await prepareProductDirectory(config.productLayout, 'ledgerBackups'),
    new Date(), { validate: validateDockerSupervisorProfile });
  if (upgrade) await observer.onLedgerUpgraded?.(upgrade);
}

/** Agent turns left running by a stopped service are closed as interrupted, never resumed. Like the upgrade, this runs only
 * under endpoint custody: a second start that fails to take the guard never closes a live service's turns. */
async function interruptAgentTurnsAtStart(config: Awaited<ReturnType<typeof loadConfig>>, observer: ConfiguredRuntimeServiceObserver) {
  let path: string;
  try { path = await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']); }
  catch (error) { if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return; throw error; }
  const store = await openSqliteAgentTurnStore(path, config.storage.sqlite, 'forbid');
  try {
    const result = await store.interruptRunning(Date.now());
    if (result.interrupted || result.corrupt.length) await observer.onAgentTurnsInterrupted?.(result);
  } finally { store.close(); }
}

/** Explicit local host. Only durable authorized shutdown intent may turn client completion into host shutdown. */
async function startService(projectRoot: string, observer: ConfiguredRuntimeServiceObserver,
  options: ConfigLoadOptions = {}) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  if (!config.cancellationRuntime || !config.cancellation) throw ErrorRegistry.createError('CANCELLATION_NOT_CONFIGURED');
  const endpoint = await prepareProductSocket(config.productLayout, 'runtimeSocket');
  // Custody before the ledger is backed up or migrated: a live host of any build holds this guard, so a second start
  // fails here and never touches the schema that host is using; custody is kept until the listener is up (Astra 2054 R1).
  const guard = await acquireLocalRuntimeSocketGuard(socketOptions(config.service, endpoint));
  try { return await startUnderCustody(projectRoot, observer, options, config, guard); }
  catch (error) { await guard.release(); throw error; }
}

async function startUnderCustody(projectRoot: string, observer: ConfiguredRuntimeServiceObserver, options: ConfigLoadOptions,
  config: Awaited<ReturnType<typeof loadConfig>>, guard: LocalRuntimeSocketGuard) {
  await upgradeLedgerAtStart(config, observer);
  await interruptAgentTurnsAtStart(config, observer);
  const preparedRecovery = await prepareConfiguredCancellationRuntime(projectRoot, observer, options);
  const preparedReconciliation = config.reconciliationRuntime ? await prepareConfiguredReconciliationRuntime(projectRoot, {
    onPage: (command, result) => observer.onReconciliationPage?.(command, result),
    onError: (command, error) => observer.onReconciliationError?.(command, error),
  }, options) : null;
  const instanceId = randomUUID();
  const modelHost = { ownerId: instanceId, controllers: new ModelInvocationControllers(config.service.maxConcurrentExecutions) };
  // Service stop cancels running turns (they close as cancelled, not interrupted).
  const turnStop = new AbortController();
  const chatTurnHost = createRuntimeChatTurnHost(modelHost, turnStop.signal);
  const preparedModelCancellation = await prepareConfiguredModelCancellationRuntime(projectRoot, modelHost.controllers, {
    onPage: (command, result) => observer.onModelCancellationPage?.(command, result),
    onError: (command, error) => observer.onModelCancellationError?.(command, error),
  }, options);
  const build = readBuildIdentity();
  const descriptor = runtimeServiceDescriptorSchema.parse({ schemaVersion: 1, instanceId,
    shutdownAvailable: config.service.identity !== null, identity: config.service.identity, processId: process.pid,
    ...(build ? { build: { sourceTreeSha256: build.sourceTreeSha256, sourceCommit: build.sourceCommit } } : {}) });
  const shutdown = config.service.identity ? configuredServiceShutdown(config,
    serviceInstanceSchema.parse({ ...config.service.identity, instanceId })) : null;
  const remoteShutdowns = new Map<string, Promise<void>>();
  const controller = new AbortController();
  let recovery: Promise<void> = Promise.resolve();
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: config.service.maxConcurrentRequests, maxConcurrentExecutions: config.service.maxConcurrentExecutions }, () => { controller.abort(); turnStop.abort(); return recovery; }, {
    async wait(milliseconds, signal) { try { await wait(milliseconds, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; } },
  });
  const preparedRunRuntime = await prepareConfiguredRunRuntime(projectRoot, {
    ...(observer.onRunProgression ? { onRun: observer.onRunProgression } : {}),
    ...(observer.onRunProgressionError ? { onError: observer.onRunProgressionError } : {}),
  }, work => lifecycle.admit(work, 'execution'), options);
  const server = await guard.start(async (request, peer, stream, turn) => {
    try {
      if (request.operation === 'describeService') {
        const result = await lifecycle.admit(() => { runtimeServiceDescriptionInputSchema.parse(request.input); return descriptor; });
        return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result };
      }
      if (request.operation === 'shutdownService') {
        if (!shutdown) throw new ServiceShutdownError('SERVICE_SHUTDOWN_INVALID');
        const result = await lifecycle.admit(() => shutdown.admit(request.input, peer));
        return { response: { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result },
          afterResponseOrDisconnect: () => finishRemoteShutdown(result.admission) };
      }
      const result = await lifecycle.admit(() => request.operation === 'renewApproval' || request.operation === 'listApprovals' || request.operation === 'inspectApproval' || request.operation === 'decideApproval'
        ? executeRuntimeApproval(projectRoot, request, peer, config.service.responseMaxBytes, options)
        : request.operation === 'inspectProviderSpendAccount' || request.operation === 'auditProviderSpendAccount'
        ? executeConfiguredRuntimeProviderSpendOperation(projectRoot, request, peer, config.service.responseMaxBytes, options)
        : request.operation === 'invokeModel' || request.operation === 'invokeModelStream' || request.operation === 'inspectModelInvocation' || request.operation === 'purgeModelInvocationContent' || request.operation === 'cancelModelInvocation'
          ? executeConfiguredRuntimeModelOperation(projectRoot, request, peer, config.service.responseMaxBytes, options, modelHost, stream)
          : request.operation === 'chatTurn' || request.operation === 'cancelChatTurn'
          ? executeConfiguredRuntimeChatTurnOperation(projectRoot, request, peer, config.service.responseMaxBytes, options, chatTurnHost, turn)
          : executeConfiguredRuntimeOperation(projectRoot, request, options), classifyRuntimeServiceOperation(request.operation));
      return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result };
    } catch (error) {
      const failure = queryFailure(error);
      const params = runtimeServiceErrorParams(failure.params);
      return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: false,
        error: { code: failure.code, category: failure.category, ...(params ? { params } : {}) } };
    }
  });
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
  return Object.freeze({ endpoint: server.endpoint, layout: config.productLayout, done, stop });
}

export async function startConfiguredRuntimeService(projectRoot: string, observer: ConfiguredRuntimeServiceObserver,
  options: ConfigLoadOptions = {}) {
  try { return await startService(projectRoot, observer, options); }
  catch (error) { throw queryFailure(error); }
}
