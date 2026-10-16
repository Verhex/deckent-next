import type { VerifiedPrincipal } from '#domain/index.js';
import { observeRunQueue, queueObservationReadLimit, type DispatchIdentityAuthorization, type RunQuery } from '#engine/index.js';
import { GIT_QUEUE_DISPLAY, SqliteTargetQueue, openSqliteLedgerReadOnly } from '#adapters/index.js';
import type { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
type Config = Awaited<ReturnType<typeof loadConfiguredScopeContext>>['config'];
export async function observeConfiguredQueueRun(query: RunQuery, config: Config, path: () => Promise<string>, principal: VerifiedPrincipal, authorization: DispatchIdentityAuthorization) {
  const db = openSqliteLedgerReadOnly(await path(), config.storage.sqlite), queue = new SqliteTargetQueue(db), limit = config.targetQueue.perTarget;
  try { return await observeRunQueue(queue.forRun(query.scopeId, query.runId, queueObservationReadLimit(limit)), queue, limit, principal, authorization, GIT_QUEUE_DISPLAY); } finally { db.close(); }
}
