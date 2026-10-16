import type { VerifiedPrincipal, TargetQueueRecord, TargetDisplay } from '#domain/index.js';
import { queueTerminal } from '#domain/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import type { TargetQueueStore } from './target-queue.js';
import { projectTargetQueue } from './queue-view.js';
export async function observeRunQueue(rowsInput: readonly TargetQueueRecord[], queue: Pick<TargetQueueStore, 'ahead'>, limit: number,
  principal: VerifiedPrincipal, authorization: DispatchIdentityAuthorization, display: TargetDisplay) {
    const rows = rowsInput, records = [];
    for (const record of rows.slice(0, limit)) {
      await authorization.authorizeIdentity('read-output', record.request.identity, principal);
      const ahead = (queue.ahead?.(record, limit) ?? []);
      for (const entry of ahead) await authorization.authorizeIdentity('read-output', entry.request.identity, principal);
      records.push(projectTargetQueue(record, display, Date.now(), queueTerminal(record.state) || ahead.length >= limit ? null : ahead.length + 1));
    }
    return { records, truncated: rows.length > limit };
}

export const queueObservationReadLimit = (limit: number) => limit + 1;
