import { ErrorRegistry, loadConfig, type ConfigLoadOptions, type DeckentError } from '#platform/index.js';
import { CancellationRuntimeLoop, type CancellationRecoveryCommand, type CancellationRecoveryPageResult } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { recoverConfiguredCancellations } from '#composition/core/runs/index.js';

export interface ConfiguredCancellationRuntimeObserver {
  onPage(command: CancellationRecoveryCommand, result: CancellationRecoveryPageResult): void | Promise<void>;
  /** Errors are mapped through queryFailure before this observer sees them. */
  onError(command: CancellationRecoveryCommand, error: DeckentError): void | Promise<void>;
}
export interface ConfiguredCancellationRuntimeInput { readonly signal: AbortSignal; readonly observer: ConfiguredCancellationRuntimeObserver }
function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}
/** Runs recovery only for trusted configured scopes. It owns no detached timer or transport lifecycle. */
export async function runConfiguredCancellationRuntime(projectRoot: string, input: ConfiguredCancellationRuntimeInput,
  options: ConfigLoadOptions = {}): Promise<void> {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const runtime = config.cancellationRuntime;
  if (!runtime) throw ErrorRegistry.createError('CANCELLATION_NOT_CONFIGURED', { params: { missing: 'cancellationRuntime' } });
  const loop = new CancellationRuntimeLoop(async command => {
    try { return (await recoverConfiguredCancellations(projectRoot, command, options)).recovery; }
    catch (error) { throw queryFailure(error); }
  }, abortableWait, { now: Date.now }, {
    onPage: input.observer.onPage,
    async onError(command, error) { await input.observer.onError(command, queryFailure(error)); },
  }, runtime);
  await loop.run(input.signal);
}
