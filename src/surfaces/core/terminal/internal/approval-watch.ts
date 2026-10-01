import type { StandingScope } from '#surfaces/core/terminal-kit/index.js';
import { WATCH_SEEN_LIMIT } from './worker-watch.js';

/** Terminal projection of an approval record returned by the runtime approval application (display fields only). */
export interface WorklineApproval {
  readonly approvalId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly summary: string;
  readonly requester: string;
  readonly revision: number;
  readonly status: 'pending' | 'decided' | 'expired';
  readonly decision: 'allow' | 'deny' | null;
  readonly expiresAt: number;
  /** Set when the decision asked for a standing scope: what the service answered (never assumed by the view). */
  readonly standing?: { readonly scope: StandingScope; readonly saved: boolean; readonly reason?: string };
  /** B1 single card: risk and undo words (null: not declared), required assurance, and only on the running turn's card the capability its y forwards. */
  readonly risk?: string | null; readonly undo?: string | null; readonly requiredAssurance?: string; readonly decisionCapability?: string;
}

/** One page of the scope's approval records (every status; the store orders by id, not by time or state). */
export interface WorklineApprovalPage {
  readonly items: readonly WorklineApproval[];
  /** Cursor for the next page, null when this page was the last. */
  readonly nextAfter: string | null;
}

export type ListApprovalPage = (afterId: string | null) => Promise<WorklineApprovalPage>;

/** `/approvals` reads at most this many pages; more records are reported as not scanned, never silently dropped. */
export const APPROVAL_SCAN_MAX_PAGES = 10;

export function isPendingApproval(item: WorklineApproval, nowMs: number): boolean {
  return item.status === 'pending' && item.expiresAt > nowMs;
}

/** Bounded full scan for an explicit `/approvals`: pending, unexpired items, oldest request first. */
export async function scanPendingApprovals(list: ListApprovalPage, nowMs: number, maxPages = APPROVAL_SCAN_MAX_PAGES):
  Promise<{ readonly pending: readonly WorklineApproval[]; readonly truncated: boolean }> {
  const pending: WorklineApproval[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const result = await list(after);
    for (const item of result.items) if (isPendingApproval(item, nowMs)) pending.push(item);
    if (result.nextAfter === null) return { pending: sortPending(pending), truncated: false };
    after = result.nextAfter;
  }
  return { pending: sortPending(pending), truncated: true };
}

function sortPending(items: WorklineApproval[]): readonly WorklineApproval[] {
  return Object.freeze([...items].sort((left, right) => left.expiresAt - right.expiresAt || left.approvalId.localeCompare(right.approvalId)));
}

export type ApprovalWatchState = Readonly<{ cursor: string | null; notified: ReadonlySet<string> }>;
export const EMPTY_APPROVAL_WATCH: ApprovalWatchState = Object.freeze({ cursor: null, notified: new Set<string>() });

/**
 * Notification poll step: one page per heartbeat, rotating through the scope's records so the per-tick load stays one
 * bounded page however many approvals exist. Returns pending approvals not notified before; ids leave the set once seen
 * decided or expired, and the set is bounded (a forgotten id may be announced again).
 */
export function approvalWatchStep(state: ApprovalWatchState, page: WorklineApprovalPage, nowMs: number):
  { readonly state: ApprovalWatchState; readonly fresh: readonly WorklineApproval[] } {
  const notified = new Set(state.notified);
  const fresh: WorklineApproval[] = [];
  for (const item of page.items) {
    if (!isPendingApproval(item, nowMs)) { notified.delete(item.approvalId); continue; }
    if (notified.has(item.approvalId)) continue;
    notified.add(item.approvalId);
    fresh.push(item);
  }
  for (const id of notified) { if (notified.size <= WATCH_SEEN_LIMIT) break; notified.delete(id); }
  return { state: Object.freeze({ cursor: page.nextAfter, notified }), fresh: Object.freeze(fresh) };
}
