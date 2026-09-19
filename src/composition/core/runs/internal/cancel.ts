import { type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteInventoryReader, openSqliteAttemptStore } from '#adapters/index.js';
import { RunApplication, runCommandSchema, projectRunView, RunPolicyAuthorization, type RunCommand, type RunCancellation } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/** Durable cancellation intent only. Delivery to supervisors and proof of termination are separate;
 * a successful response must never be presented as stopped workers or reversed external effects.
 */
export async function requestConfiguredRunCancellation(projectRoot: string, input: RunCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = runCommandSchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options);
    const store = {
      async loadRun(scopeId: string, runId: string) {
        const reader = await openSqliteInventoryReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
        try { return await reader.loadRun(scopeId, runId); } finally { reader.close(); }
      },
      async cancelRun(request: RunCancellation) {
        const writer = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
        try { return await writer.cancelRun(request); } finally { writer.close(); }
      },
    };
    const app = new RunApplication(store, { async verify() { return principal; } }, new RunPolicyAuthorization({ async load() { return document; } }));
    const receipt = await app.execute(command);
    return Object.freeze({ schemaVersion: 1 as const, layout,
      cancellation: Object.freeze({ schemaVersion: 1 as const, commandId: receipt.commandId, run: projectRunView(receipt.snapshot) }) });
  } catch (error) { throw queryFailure(error); }
}
