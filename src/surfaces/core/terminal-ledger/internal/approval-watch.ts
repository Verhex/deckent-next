import { WATCH_SEEN_LIMIT } from './worker-watch.js';

import { isPendingApproval, type WorklineApproval, type WorklineApprovalPage } from '#surfaces/core/approval-presentation/index.js';
export { APPROVAL_SCAN_MAX_PAGES, isPendingApproval, scanPendingApprovals } from '#surfaces/core/approval-presentation/index.js';
export type { WorklineApproval, WorklineApprovalPage, ListApprovalPage } from '#surfaces/core/approval-presentation/index.js';

type ApprovalWatchState = Readonly<{ cursor: string | null; notified: ReadonlySet<string>; scanning?: ReadonlySet<string> }>;
export const EMPTY_APPROVAL_WATCH: ApprovalWatchState = Object.freeze({ cursor: null, notified: new Set<string>() });

/**
 * Notification poll step: one page per heartbeat, rotating through the scope's records so the per-tick load stays one
 * bounded page however many approvals exist. Returns pending approvals not notified before; ids leave the set once seen
 * decided or expired, and the set is bounded (a forgotten id may be announced again).
 */
export function approvalWatchStep(state: ApprovalWatchState, page: WorklineApprovalPage, nowMs: number):
  { readonly state: ApprovalWatchState; readonly fresh: readonly WorklineApproval[] } {
  let notified = new Set(state.notified);
  const scanning = new Set(state.cursor === null ? [] : state.scanning);
  const fresh: WorklineApproval[] = [];
  for (const item of page.items) {
    if (!isPendingApproval(item, nowMs)) { notified.delete(item.approvalId); continue; }
    scanning.add(item.approvalId);
    if (notified.has(item.approvalId)) continue;
    notified.add(item.approvalId);
    fresh.push(item);
  }
  if (page.nextAfter === null) notified = scanning;
  for (const id of notified) { if (notified.size <= WATCH_SEEN_LIMIT) break; notified.delete(id); }
  return { state: Object.freeze({ cursor: page.nextAfter, notified, scanning: new Set([...scanning].slice(-WATCH_SEEN_LIMIT)) }), fresh: Object.freeze(fresh) };
}
