import type { DatabaseSync } from 'node:sqlite';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { deriveRunBlocker, deriveRunState, type MonitorDeliveryState, type MonitorLedgerReading, type MonitorLedgerRun, type ResultBrief } from '#engine/index.js';

type Receipt = NonNullable<MonitorLedgerRun['deliveryReceipts']>[number];
// First ledger versions of integration, delivery and adoption evidence (schema.ts history).
const INTEGRATION_VERSION = 30, DELIVERY_VERSION = 32, ADOPTION_VERSION = 33;
/** Retain the command's full producer identity alongside every receipt, including historical Attempts. */
export function readDeliveryReceipts(db: DatabaseSync, version: number) {
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
  const fields = "scope_id,command_id,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.command.identity.runId') END AS run_id,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.command.identity') END AS identity";
  if (version >= INTEGRATION_VERSION) for (const row of db.prepare(`SELECT ${fields},manifest FROM workspace_integrations`).all())
    put(row, row.manifest === null ? 'integrating' : 'integrated', null, null);
  if (version >= DELIVERY_VERSION) for (const row of db.prepare(`SELECT ${fields},delivered,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.plan.ref') END AS target_ref,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.plan.commit') END AS commit_id FROM workspace_deliveries`).all())
    put(row, row.delivered === 1 ? 'delivered' : 'delivering', row.commit_id, row.target_ref);
  if (version >= ADOPTION_VERSION) for (const row of db.prepare(`SELECT ${fields},CASE WHEN json_valid(intent) THEN json_extract(intent,'$.targetRef') END AS target_ref,kind,settled,sequence,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.toCommit') END AS commit_id FROM workspace_adoptions ORDER BY sequence`).all())
    put(row, row.kind === 'rollback' ? (row.settled === 1 ? 'rolled-back' : 'rolling-back') : (row.settled === 1 ? 'adopted' : 'adopting'), row.commit_id, row.target_ref);
  return histories;
}
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
