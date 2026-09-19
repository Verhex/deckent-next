import { socketOptions } from './socket-options.js';
import { setTimeout as wait } from 'node:timers/promises';
import { ErrorRegistry, loadConfig, prepareProductSocket, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, startLocalRuntimeSocketServer, LocalRuntimeSocketError } from '#adapters/index.js';
import { RuntimeServiceLifecycle, classifyRuntimeServiceOperation, type RuntimeServiceDrainResult } from '#engine/index.js';
import { prepareConfiguredCancellationRuntime, prepareConfiguredReconciliationRuntime, type ConfiguredReconciliationRuntimeObserver, type ConfiguredCancellationRuntimeObserver } from '#composition/core/runtime/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { executeConfiguredRuntimeOperation } from './operations.js';

export interface ConfiguredRuntimeServiceObserver extends ConfiguredCancellationRuntimeObserver {
  onReconciliationPage?: ConfiguredReconciliationRuntimeObserver['onPage'];
  onReconciliationError?: ConfiguredReconciliationRuntimeObserver['onError'];
}

/** Explicit local host. Client disconnects never call worker cancellation or stop this host. */
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
  const controller = new AbortController();
  let recovery: Promise<void> = Promise.resolve();
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: config.service.maxConcurrentRequests, maxConcurrentExecutions: config.service.maxConcurrentExecutions }, () => { controller.abort(); return recovery; }, {
    async wait(milliseconds, signal) { try { await wait(milliseconds, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; } },
  });
  const server = await startLocalRuntimeSocketServer(socketOptions(config.service, endpoint), async request => {
    try {
      const result = await lifecycle.admit(() => executeConfiguredRuntimeOperation(projectRoot, request, options), classifyRuntimeServiceOperation(request.operation));
      return { schemaVersion: 1, requestId: request.requestId, ok: true, result };
    } catch (error) {
      const failure = queryFailure(error);
      return { schemaVersion: 1, requestId: request.requestId, ok: false, error: { code: failure.code, category: failure.category } };
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
    void lifecycle.whenSettled().then(() => transportFailure ? rejectDone(transportFailure) : resolveDone(), error => rejectDone(queryFailure(error)));
    return stopping;
  };
  void server.termination.then(event => {
    if (event.reason !== 'requested') {
      transportFailure = queryFailure(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT'));
      void stop().catch(error => rejectDone(queryFailure(error)));
    }
  });
  const hostedRecovery = [
    preparedRecovery.run(controller.signal),
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
