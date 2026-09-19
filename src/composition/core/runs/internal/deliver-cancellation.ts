import { randomUUID } from 'node:crypto';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { authenticate, RunApplication, runCommandSchema, RunPolicyAuthorization, RunCancellationCoordinator, type RunCommand } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createRecordedCancellationDelivery } from './cancellation-runtime.js';
/** Explicit delivery, separate from request-only SDK entry. Current Run and per-Attempt policy gate
 * every delivery; stopped containers stay retained until independent output durability/release.
 */
export async function deliverConfiguredRunCancellation(projectRoot: string, input: RunCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = runCommandSchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options);
    const verifier = { async verify() { return principal; } }; const authorization = new RunPolicyAuthorization({ async load() { return document; } });
    const actor = await authenticate(verifier, undefined, command.scopeId);
    await authorization.authorize('cancel', command, actor);
    if (!config.cancellation) throw ErrorRegistry.createError('CANCELLATION_NOT_CONFIGURED', {
      params: { missing: 'cancellation' },
    });
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      const runs = new RunApplication(store, verifier, authorization);
      // No runtime dependency is touched for an attempt that has never been dispatched.
      // Each attempt has its own immutable profile; never share one mutable configuration across workers.
      const delivery = createRecordedCancellationDelivery(store, config, layout, principal, verifier);
      const coordinator = new RunCancellationCoordinator(runs, store, delivery, config.cancellation, { now: Date.now, token: randomUUID });
      return Object.freeze({ schemaVersion: 1 as const, layout, delivery: await coordinator.cancel(command) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
