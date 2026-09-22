import type { WorkLedgerWorkerEntry } from './work-ledger.js';

/** Remembered identities are bounded; the oldest are forgotten first (a forgotten worker may be shown again). */
export const WATCH_SEEN_LIMIT = 4096;

export function newWorkerTaskIds(
  seen: ReadonlySet<string>,
  workers: readonly WorkLedgerWorkerEntry[],
): { readonly seen: Set<string>; readonly fresh: readonly WorkLedgerWorkerEntry[] } {
  const next = new Set(seen);
  const fresh: WorkLedgerWorkerEntry[] = [];
  for (const worker of workers) {
    const key = `${worker.scopeId}:${worker.taskId}`;
    if (next.has(key)) continue;
    next.add(key);
    fresh.push(worker);
  }
  for (const key of next) { if (next.size <= WATCH_SEEN_LIMIT) break; next.delete(key); }
  return { seen: next, fresh: Object.freeze(fresh) };
}
