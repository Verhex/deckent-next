import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { ConfigLoadOptions } from '#platform/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { authenticate, PoolPolicyAuthorization, RunPolicyAuthorization, RunReservationApplication, runReservationCommandSchema, type RunReservationCommand } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredRunContext } from './context.js';

/** Reserve the next scheduler-selected wave using the persisted Run policy and shared pool. */
export async function reserveConfiguredRunTasks(projectRoot: string, input: RunReservationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = runReservationCommandSchema.parse(input);
    const { config, layout, principal, path } = await loadConfiguredRunContext(projectRoot, command.scopeId, options);
    const verifier = { async verify() { return principal; } };
    const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
    const authorization = new RunPolicyAuthorization(source);
    const poolAuthorization = new PoolPolicyAuthorization(source);
    await authorization.authorize('reserve', command, await authenticate(verifier, undefined, command.scopeId));
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    try {
      const application = new RunReservationApplication(store, verifier, authorization, poolAuthorization, { now: Date.now, attemptId: randomUUID });
      return Object.freeze({ schemaVersion: 1 as const, layout, reservation: await application.reserve(command) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
