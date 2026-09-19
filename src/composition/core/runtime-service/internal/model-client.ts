import type { ModelInvocationCommand, ModelInvocationQuery } from '#domain/index.js';
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
export function inspectRuntimeModelInvocation(projectRoot: string, input: ModelInvocationQuery, options: ConfigLoadOptions = {}) {
  return createConfiguredRuntimeClient(projectRoot, options).inspectModelInvocation(input);
}
