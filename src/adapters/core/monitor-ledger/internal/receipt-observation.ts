import type { DatabaseSync } from 'node:sqlite';
import { createMonitorDeliveryProjection } from '#engine/index.js';

// First ledger versions of integration, delivery and adoption evidence (schema.ts history).
const INTEGRATION_VERSION = 30, DELIVERY_VERSION = 32, ADOPTION_VERSION = 33;
/** Retain the command's full producer identity alongside every receipt, including historical Attempts. */
export function readDeliveryReceipts(db: DatabaseSync, version: number) {
  const { histories, put } = createMonitorDeliveryProjection();
  const fields = "scope_id,command_id,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.command.identity.runId') END AS run_id,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.command.identity') END AS identity";
  if (version >= INTEGRATION_VERSION) for (const row of db.prepare(`SELECT ${fields},manifest FROM workspace_integrations`).all())
    put(row, row.manifest === null ? 'integrating' : 'integrated', null, null);
  if (version >= DELIVERY_VERSION) for (const row of db.prepare(`SELECT ${fields},delivered,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.plan.ref') END AS target_ref,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.plan.commit') END AS commit_id FROM workspace_deliveries`).all())
    put(row, row.delivered === 1 ? 'delivered' : 'delivering', row.commit_id, row.target_ref);
  if (version >= ADOPTION_VERSION) for (const row of db.prepare(`SELECT ${fields},CASE WHEN json_valid(intent) THEN json_extract(intent,'$.targetRef') END AS target_ref,kind,settled,sequence,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.toCommit') END AS commit_id FROM workspace_adoptions ORDER BY sequence`).all())
    put(row, row.kind === 'rollback' ? (row.settled === 1 ? 'rolled-back' : 'rolling-back') : (row.settled === 1 ? 'adopted' : 'adopting'), row.commit_id, row.target_ref);
  return histories;
}
export { aggregateDelivery, authorizeMonitorDelivery } from '#engine/index.js';
