import { startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import type { ConfiguredCancellationRuntimeObserver } from '#composition/core/runtime/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';

/** Composition binds the local runtime host; the CLI owns signal handling and rendering. */
export async function startConfiguredCliRuntimeService(projectRoot: string, observer: ConfiguredCancellationRuntimeObserver,
  options: ConfigLoadOptions = {}) {
  return startConfiguredRuntimeService(projectRoot, observer, options);
}
