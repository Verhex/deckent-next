import { z } from 'zod';
import defaults from './events-defaults.json' with { type: 'json' };
const count = z.number().int().positive().safe();
const timer = count.max(2147483647);
/** Versioned observation policy; no execution or mutation authority is granted by these limits. */
export const RUNTIME_EVENTS_SETTINGS = z.object({ schemaVersion: z.literal(1).default(defaults.schemaVersion as 1), enabled: z.boolean().default(defaults.enabled),
  maxSubscribers: count.default(defaults.maxSubscribers), maxSubscribersPerPrincipal: count.default(defaults.maxSubscribersPerPrincipal),
  maxViews: count.default(defaults.maxViews), maxObservedScopes: count.default(defaults.maxObservedScopes),
  subscriberMaxEvents: count.min(2).default(defaults.subscriberMaxEvents), subscriberMaxBytes: count.default(defaults.subscriberMaxBytes),
  viewReplayMaxEvents: count.default(defaults.viewReplayMaxEvents), viewReplayMaxBytes: count.default(defaults.viewReplayMaxBytes),
  resumeTtlMs: timer.default(defaults.resumeTtlMs), readPageSize: count.default(defaults.readPageSize),
  maxSnapshotRows: count.default(defaults.maxSnapshotRows), maxSnapshotBytes: count.default(defaults.maxSnapshotBytes),
  snapshotDeadlineMs: timer.default(defaults.snapshotDeadlineMs), snapshotRetryLimit: count.default(defaults.snapshotRetryLimit),
  heartbeatMs: timer.default(defaults.heartbeatMs), idleTimeoutMs: timer.default(defaults.idleTimeoutMs), drainTimeoutMs: timer.default(defaults.drainTimeoutMs),
  closeGraceMs: timer.default(defaults.closeGraceMs), authorizationRefreshMs: timer.default(defaults.authorizationRefreshMs),
  reconcileIntervalMs: timer.default(defaults.reconcileIntervalMs), maxConcurrentHydrations: count.default(defaults.maxConcurrentHydrations),
  liveWorkerMaxEvents: count.default(defaults.liveWorkerMaxEvents), liveWorkerMaxBytes: count.default(defaults.liveWorkerMaxBytes),
  liveWorkerFlushMs: timer.default(defaults.liveWorkerFlushMs),
}).strict().superRefine((value, context) => {
  for (const [ok, path] of [[value.idleTimeoutMs > value.heartbeatMs, 'idleTimeoutMs'],
    [value.maxSubscribersPerPrincipal <= value.maxSubscribers, 'maxSubscribersPerPrincipal'],
    [value.readPageSize <= value.maxSnapshotRows, 'readPageSize'],
    [value.authorizationRefreshMs <= value.heartbeatMs, 'authorizationRefreshMs'],
    [value.drainTimeoutMs < value.idleTimeoutMs, 'drainTimeoutMs']] as const) {
    if (!ok) context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: 'EVENTS_LIMIT_ORDER' });
  }
});
export type RuntimeEventsSettings = z.infer<typeof RUNTIME_EVENTS_SETTINGS>;
