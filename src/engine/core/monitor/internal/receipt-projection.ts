import { attemptIdentitySchema } from '#domain/index.js';
import type { MonitorDeliveryState } from './contract.js';
import type { MonitorLedgerRun } from './evidence.js';
type Receipt = NonNullable<MonitorLedgerRun['deliveryReceipts']>[number];
/** Producer identity and safe receipt fields only; called with already-read storage rows. */
export function createMonitorDeliveryProjection() {
  const histories = new Map<string, Receipt[]>();
  const put = (row: Record<string, unknown>, state: MonitorDeliveryState, commit: unknown, targetRef: unknown) => {
    let identity;
    try { identity = attemptIdentitySchema.safeParse(JSON.parse(String(row.identity))); } catch { identity = null; }
    const producer = identity?.success && identity.data.scopeId === row.scope_id && identity.data.runId === row.run_id ? identity.data : null;
    const key = `${row.scope_id}/${row.run_id}`, receipts = histories.get(key) ?? [];
    receipts.push(Object.freeze({ identity: producer, receipt: Object.freeze({ state,
      commit: typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit) ? commit : null,
      commandId: typeof row.command_id === 'string' ? row.command_id : null, targetRef: typeof targetRef === 'string' ? targetRef : null }) }));
    histories.set(key, receipts);
  };
  return { histories, put };
}
