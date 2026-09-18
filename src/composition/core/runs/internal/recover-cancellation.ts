import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { authenticate, cancellationRecoveryCommandSchema, CancellationRecoveryApplication, DispatchInventoryPolicyAuthorization,
  RunPolicyAuthorization, type CancellationRecoveryCommand } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { createRecordedCancellationDelivery } from './cancellation-runtime.js';
import { loadConfiguredRunContext } from './context.js';

/** Manually drain one bounded page of durable cancellation intent. This does not host a daemon
 * or register an automatic startup loop. */
export async function recoverConfiguredCancellations(projectRoot: string, input: CancellationRecoveryCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = cancellationRecoveryCommandSchema.parse(input);
    const { config, layout, principal, path } = await loadConfiguredRunContext(projectRoot, command.scopeId, options);
    const verifier = { async verify() { return principal; } };
    const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
    const scope = new DispatchInventoryPolicyAuthorization(source);
    const actor = await authenticate(verifier, undefined, command.scopeId);
    await scope.authorize(command.scopeId, actor);
    if (!config.cancellation) throw ErrorRegistry.createError('CANCELLATION_NOT_CONFIGURED', { params: { missing: 'cancellation' } });
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      const delivery = createRecordedCancellationDelivery(store, config, layout, principal, verifier);
      const application = new CancellationRecoveryApplication(store, verifier, scope, new RunPolicyAuthorization(source), delivery,
        { ...config.cancellation, maxPageSize: config.cancellation.recoveryPageSize }, { now: Date.now, token: randomUUID });
      return Object.freeze({ schemaVersion: 1 as const, layout, recovery: await application.drain(command) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
