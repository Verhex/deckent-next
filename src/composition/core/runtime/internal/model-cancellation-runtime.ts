import { loadConfig, type ConfigLoadOptions, type DeckentError } from '#platform/index.js';
import { ModelCancellationRuntimeLoop, ModelInvocationStoreError,
  type ModelInvocationControllers, type ModelInvocationCancellationRecoveryCommand,
  type ModelInvocationCancellationRecoveryPage } from '#engine/index.js';
import { recoverConfiguredModelCancellations } from '#composition/core/model-invocation/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { abortableRuntimeWait } from './wait.js';

export interface ConfiguredModelCancellationRuntimeObserver {
  onPage(command: ModelInvocationCancellationRecoveryCommand, result: ModelInvocationCancellationRecoveryPage): void | Promise<void>;
  onError(command: ModelInvocationCancellationRecoveryCommand, error: DeckentError): void | Promise<void>;
}
export async function prepareConfiguredModelCancellationRuntime(projectRoot: string, controllers: ModelInvocationControllers,
  observer: ConfiguredModelCancellationRuntimeObserver, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  if (!config.cancellationRuntime || !config.cancellation) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  const layoutIdentity = JSON.stringify(config.productLayout);
  const loop = new ModelCancellationRuntimeLoop(command => recoverConfiguredModelCancellations(projectRoot, command,
    controllers, layoutIdentity, options), abortableRuntimeWait, { now: Date.now }, {
    onPage: observer.onPage,
    async onError(command, error) { await observer.onError(command, queryFailure(error)); },
  }, config.cancellationRuntime);
  return Object.freeze({ run: (signal: AbortSignal) => loop.run(signal) });
}
