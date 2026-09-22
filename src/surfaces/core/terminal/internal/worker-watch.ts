import type { WorkLedgerWorkerEntry } from './work-ledger.js';

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
  return { seen: next, fresh: Object.freeze(fresh) };
}
