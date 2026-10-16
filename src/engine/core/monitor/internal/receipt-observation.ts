import type { AttemptIdentity } from '#domain/index.js';
import type { ResultBrief } from '#engine/core/runs/index.js';
import { deriveRunBlocker, deriveRunState } from './derive.js';
import type { MonitorDeliveryState } from './contract.js';
import type { MonitorLedgerReading, MonitorLedgerRun } from './evidence.js';
type Receipt = NonNullable<MonitorLedgerRun['deliveryReceipts']>[number];
/** Recompute the furthest visible step after authorization; a hidden later receipt never controls the summary. */
export function aggregateDelivery(receipts: readonly Receipt[]): ResultBrief['runDelivery'] {
  const rank = (state: MonitorDeliveryState) => ['integrating', 'integrated'].includes(state) ? 1 : ['delivering', 'delivered'].includes(state) ? 2 : 3;
  let latest: Receipt | undefined;
  for (const value of receipts) if (!latest || rank(value.receipt.state) >= rank(latest.receipt.state)) latest = value;
  return latest ? Object.freeze({ ...latest.receipt, receipts: Object.freeze(receipts.map(value => value.receipt)) }) : null;
}
/** One output gate for monitor, inspection and evaluation, independent of which task receives a brief. */
export async function authorizeMonitorDelivery<T extends MonitorLedgerReading>(reading: T, readOutput: (identity: AttemptIdentity) => Promise<boolean>): Promise<T> {
  const decisions = new Map<string, boolean>();
  const allowed = async (identity: AttemptIdentity) => {
    const key = JSON.stringify(identity);
    if (!decisions.has(key)) decisions.set(key, await readOutput(identity));
    return decisions.get(key)!;
  };
  const runs: MonitorLedgerRun[] = [];
  for (const run of reading.runs) {
    const evidence = { run, workers: new Map(), approvals: reading.approvals, pool: null, observedAt: Date.now() };
    const hasOutlook = deriveRunState(evidence, deriveRunBlocker(evidence)) === 'accepted';
    let deliveryOutputPermitted = hasOutlook && run.snapshot.bindings.length > 0;
    if (hasOutlook) for (const binding of run.snapshot.bindings) if (!(await allowed(binding.identity))) deliveryOutputPermitted = false;
    const receipts: Receipt[] = [];
    for (const value of run.deliveryReceipts ?? []) if (value.identity && await allowed(value.identity)) receipts.push(value);
    // No identity custody (including an older reader) means no aggregate, never inherited Run authority.
    runs.push(Object.freeze({ ...run, deliveryReceipts: Object.freeze(receipts), delivery: aggregateDelivery(receipts), deliveryOutputPermitted }));
  }
  return Object.freeze({ ...reading, runs: Object.freeze(runs) });
}
