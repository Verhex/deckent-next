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

/**
 * Key mapping for a decision card. Only a single typed `y`/`Y` says yes; `n`/`N`, Enter and Esc say no (the safe default).
 * Pasted or multi-character input, control sequences and every other key leave the card waiting. There is no
 * "always"/remember key: every gated item is decided one by one (legacy `a` is deliberately absent).
 */
export function decisionKey(input: string, key: { readonly return?: boolean; readonly escape?: boolean; readonly ctrl?: boolean; readonly meta?: boolean }):
  'yes' | 'no' | null {
  if (key.return || key.escape) return 'no';
  if (key.ctrl || key.meta || input.length !== 1) return null;
  if (input === 'y' || input === 'Y') return 'yes';
  if (input === 'n' || input === 'N') return 'no';
  return null;
}
