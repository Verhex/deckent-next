import type { ModelBindingDefinition, ModelInvocationProfile } from '#domain/index.js';
import { ProviderSpendError } from '#engine/core/provider-spend/index.js';
import type { ModelInvocationNativePort, ModelInvocationNativeRegistry } from './application.js';
import { ModelInvocationStoreError } from './port.js';

export interface ModelInvocationAcquisitionInput {
  readonly profile: ModelInvocationProfile;
  readonly definition: ModelBindingDefinition;
  readonly native: ModelInvocationNativePort;
}

/** Authorized metadata acquisition only. Never model execution, credentials or a monetary claim.
 * Late completion cannot resume prepare/claim/send; adapters must also honour the supplied abort signal.
 */
export async function acquireModelInvocationEvidence(registry: ModelInvocationNativeRegistry,
  input: ModelInvocationAcquisitionInput, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  if (!registry.acquire) return;
  const controller = new AbortController();
  const bounded = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), Math.min(input.profile.limits.timeoutMs, 2_147_483_647));
  timer.unref();
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE'));
      bounded.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => {
        if (bounded.aborted) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
        return registry.acquire!(Object.freeze(input), bounded);
      }).then(resolve, reject);
    });
    if (bounded.aborted) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  } catch (error) {
    if (error instanceof ProviderSpendError) throw error;
    // Do not expose a remote URL, headers or backend diagnostics through the public error.
    throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    if (abort) bounded.removeEventListener('abort', abort);
  }
}
