import type { ModelInvocationCancellationCommand, ModelInvocationCommand, ModelInvocationDeltaSink, ModelInvocationQuery,
  ModelInvocationPurgeCommand } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { createConfiguredRuntimeClient } from './client.js';

/**
 * Abort stops the client's wait, never the runtime-owned model operation. Missing service has no direct fallback.
 * The local service supports peers of its own OS UID only; this is not a multi-user identity boundary.
 * `replayed` reports the service's handling of this request, not independently verifiable billing evidence.
 * Persisted invocation identities/outcomes, not this hint, govern accounting and subsequent actions.
 */
export function invokeRuntimeModel(projectRoot: string, input: ModelInvocationCommand, options: ConfigLoadOptions = {}, signal?: AbortSignal) {
  return createConfiguredRuntimeClient(projectRoot, options).invokeModel(input, undefined, signal);
}
/** Streamed form of invokeRuntimeModel: deltas are presentation only; abort disconnects, it does not cancel. */
export function invokeRuntimeModelStream(projectRoot: string, input: ModelInvocationCommand, onDelta: ModelInvocationDeltaSink,
  options: ConfigLoadOptions = {}, signal?: AbortSignal) {
  return createConfiguredRuntimeClient(projectRoot, options).invokeModelStream(input, onDelta, undefined, signal);
}
export function inspectRuntimeModelInvocation(projectRoot: string, input: ModelInvocationQuery, options: ConfigLoadOptions = {}) {
  return createConfiguredRuntimeClient(projectRoot, options).inspectModelInvocation(input);
}
export function purgeRuntimeModelInvocationContent(projectRoot: string, input: ModelInvocationPurgeCommand, options: ConfigLoadOptions = {}) {
  return createConfiguredRuntimeClient(projectRoot, options).purgeModelInvocationContent(input);
}
export function cancelRuntimeModelInvocation(projectRoot: string, input: ModelInvocationCancellationCommand, options: ConfigLoadOptions = {}) {
  return createConfiguredRuntimeClient(projectRoot, options).cancelModelInvocation(input);
}
