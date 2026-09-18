import { socketOptions } from './socket-options.js';
import { setTimeout as wait } from 'node:timers/promises';
import { ErrorRegistry, loadConfig, prepareProductSocket, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, startLocalRuntimeSocketServer } from '#adapters/index.js';
import { RuntimeServiceLifecycle, classifyRuntimeServiceOperation, type RuntimeServiceDrainResult } from '#engine/index.js';
import { prepareConfiguredCancellationRuntime, type ConfiguredCancellationRuntimeObserver } from '#composition/core/runtime/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { executeConfiguredRuntimeOperation } from './operations.js';

/** Explicit local host. Client disconnects never call worker cancellation or stop this host. */
async function startService(projectRoot: string, observer: ConfiguredCancellationRuntimeObserver,
  options: ConfigLoadOptions = {}) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  if (!config.cancellationRuntime || !config.cancellation) throw ErrorRegistry.createError('CANCELLATION_NOT_CONFIGURED');
  const preparedRecovery = await prepareConfiguredCancellationRuntime(projectRoot, observer, options);
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
  const stop = () => {
    if (stopping) return stopping;
    server.stopAccepting();
    stopping = lifecycle.stop(config.service.shutdownGraceMs);
    // Keep the kernel guard through actual completion, even after the caller sees an incomplete grace result.
    void lifecycle.whenSettled().then(async () => { await server.dispose(); resolveDone(); }, async error => {
      try { await server.dispose(); } finally { rejectDone(queryFailure(error)); }
    }).catch(error => rejectDone(queryFailure(error)));
    return stopping;
  };
  recovery = preparedRecovery.run(controller.signal);
  void recovery.catch(() => { void stop().catch(() => undefined); });
  return Object.freeze({ endpoint: server.endpoint, layout: config.productLayout, done, stop });
}

export async function startConfiguredRuntimeService(projectRoot: string, observer: ConfiguredCancellationRuntimeObserver,
  options: ConfigLoadOptions = {}) {
  try { return await startService(projectRoot, observer, options); }
  catch (error) { throw queryFailure(error); }
}
