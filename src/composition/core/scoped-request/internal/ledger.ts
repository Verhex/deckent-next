import type { ResolvedConfig } from '#platform/index.js';
import type { SupervisorProfileValidator } from '#engine/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
/** The admitted context owns path custody; each caller keeps its migration posture and profile validator. */
export async function openConfiguredLedger(context: { readonly config: Pick<ResolvedConfig, 'storage' | 'runRuntime'>; path(): Promise<string> },
  options: { readonly migration: 'allow' | 'forbid'; readonly validate?: SupervisorProfileValidator['validate'] }) {
  return openSqliteAttemptStore(await context.path(), context.config.storage.sqlite, { now: Date.now, timeoutMs: context.config.runRuntime.parking.timeoutMs },
    options.migration, options.validate === undefined ? undefined : { validate: options.validate });
}
