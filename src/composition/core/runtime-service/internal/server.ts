import { prepareConfiguredRunRuntime, type RunProgressionObserver } from '#composition/core/run-progression/index.js';
import { RUNTIME_SERVICE_SCHEMA_VERSION } from '#engine/index.js';
import { socketOptions } from './socket-options.js';
import { configuredServiceShutdown } from './shutdown.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { ErrorRegistry, loadConfig, prepareProductSocket, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, startLocalRuntimeSocketServer, LocalRuntimeSocketError } from '#adapters/index.js';
import { ModelInvocationControllers, RuntimeServiceLifecycle, classifyRuntimeServiceOperation, runtimeServiceDescriptorSchema, runtimeServiceDescriptionInputSchema,
  serviceInstanceSchema, ServiceShutdownError, type ShutdownAdmission, type RuntimeServiceDrainResult } from '#engine/index.js';
import { prepareConfiguredCancellationRuntime, prepareConfiguredReconciliationRuntime, type ConfiguredReconciliationRuntimeObserver, type ConfiguredCancellationRuntimeObserver } from '#composition/core/runtime/index.js';
import { prepareConfiguredModelCancellationRuntime, type ConfiguredModelCancellationRuntimeObserver } from '#composition/core/runtime/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { executeConfiguredRuntimeOperation } from './operations.js';
import { executeConfiguredRuntimeModelOperation } from './model-invocation.js';
import { executeConfiguredRuntimeProviderSpendOperation } from './provider-spend.js';

export interface ConfiguredRuntimeServiceObserver extends ConfiguredCancellationRuntimeObserver {
  onRunProgression?: RunProgressionObserver['onRun'];
  onRunProgressionError?: RunProgressionObserver['onError'];
  onReconciliationPage?: ConfiguredReconciliationRuntimeObserver['onPage'];
  onReconciliationError?: ConfiguredReconciliationRuntimeObserver['onError'];
  onModelCancellationPage?: ConfiguredModelCancellationRuntimeObserver['onPage'];
  onModelCancellationError?: ConfiguredModelCancellationRuntimeObserver['onError'];
}

/** Explicit local host. Only durable authorized shutdown intent may turn client completion into host shutdown. */
async function startService(projectRoot: string, observer: ConfiguredRuntimeServiceObserver,
  options: ConfigLoadOptions = {}) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  if (!config.cancellationRuntime || !config.cancellation) throw ErrorRegistry.createError('CANCELLATION_NOT_CONFIGURED');
  const preparedRecovery = await prepareConfiguredCancellationRuntime(projectRoot, observer, options);
  const preparedReconciliation = config.reconciliationRuntime ? await prepareConfiguredReconciliationRuntime(projectRoot, {
    onPage: (command, result) => observer.onReconciliationPage?.(command, result),
    onError: (command, error) => observer.onReconciliationError?.(command, error),
  }, options) : null;
  const endpoint = await prepareProductSocket(config.productLayout, 'runtimeSocket');
  const instanceId = randomUUID();
  const modelHost = { ownerId: instanceId, controllers: new ModelInvocationControllers(config.service.maxConcurrentExecutions) };
  const preparedModelCancellation = await prepareConfiguredModelCancellationRuntime(projectRoot, modelHost.controllers, {
    onPage: (command, result) => observer.onModelCancellationPage?.(command, result),
    onError: (command, error) => observer.onModelCancellationError?.(command, error),
  }, options);
  const descriptor = runtimeServiceDescriptorSchema.parse({ schemaVersion: 1, instanceId,
    shutdownAvailable: config.service.identity !== null, identity: config.service.identity });
  const shutdown = config.service.identity ? configuredServiceShutdown(config,
    serviceInstanceSchema.parse({ ...config.service.identity, instanceId })) : null;
  const remoteShutdowns = new Map<string, Promise<void>>();
  const controller = new AbortController();
  let recovery: Promise<void> = Promise.resolve();
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: config.service.maxConcurrentRequests, maxConcurrentExecutions: config.service.maxConcurrentExecutions }, () => { controller.abort(); return recovery; }, {
    async wait(milliseconds, signal) { try { await wait(milliseconds, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; } },
  });
  const preparedRunRuntime = await prepareConfiguredRunRuntime(projectRoot, {
    ...(observer.onRunProgression ? { onRun: observer.onRunProgression } : {}),
    ...(observer.onRunProgressionError ? { onError: observer.onRunProgressionError } : {}),
  }, work => lifecycle.admit(work, 'execution'), options);
  const server = await startLocalRuntimeSocketServer(socketOptions(config.service, endpoint), async (request, peer) => {
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
      const result = await lifecycle.admit(() => request.operation === 'inspectProviderSpendAccount' || request.operation === 'auditProviderSpendAccount'
        ? executeConfiguredRuntimeProviderSpendOperation(projectRoot, request, peer, config.service.responseMaxBytes, options)
        : request.operation === 'invokeModel' || request.operation === 'inspectModelInvocation' || request.operation === 'purgeModelInvocationContent' || request.operation === 'cancelModelInvocation'
          ? executeConfiguredRuntimeModelOperation(projectRoot, request, peer, config.service.responseMaxBytes, options, modelHost)
          : executeConfiguredRuntimeOperation(projectRoot, request, options), classifyRuntimeServiceOperation(request.operation));
      return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result };
    } catch (error) {
      const failure = queryFailure(error);
      return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: false, error: { code: failure.code, category: failure.category } };
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
