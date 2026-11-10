import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';

/** Owner B1-7/8: one additive upgrade. Caller owns the transaction; existing records stay byte-for-byte unchanged.
 * Old resource keys stay NULL; capacity verifies their JSON as before. Owner: alpha.64 writers ship now; no alpha.63.3 rollback. */
export function migrateLedgerIndexes(db: DatabaseSync): void {
  try { db.exec(`ALTER TABLE model_invocations ADD COLUMN resource_key TEXT REFERENCES capacity_resources(resource_key);
    CREATE INDEX model_invocations_resource_claimed ON model_invocations(resource_key) WHERE state='claimed';
    CREATE INDEX runs_nonterminal ON runs(scope_id,run_id) WHERE (CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.state.kind') END)!='terminal';
    CREATE INDEX runs_pool ON runs((CASE WHEN json_valid(policy) THEN json_extract(policy,'$.poolId') END));
    CREATE INDEX effect_intents_compensates ON effect_intents(scope_id,(CASE WHEN json_valid(record) THEN json_extract(record,'$.intent.command.compensates') END),CASE state WHEN 'settled' THEN 0 ELSE 1 END,sequence DESC) WHERE state!='refused';
    CREATE INDEX run_receipts_evaluation ON run_receipts(scope_id,(CASE WHEN json_valid(command) THEN json_extract(command,'$.evaluation.identity.runId') END),(CASE WHEN json_valid(command) THEN json_extract(command,'$.evaluation.identity.attemptId') END),(CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.revision') END) DESC) WHERE (CASE WHEN json_valid(command) THEN json_extract(command,'$.action') END)='apply-task-evaluation';
    CREATE INDEX approvals_pending ON approvals(subject_kind,scope_id,approval_id) WHERE current=1 AND (CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.status') END)='pending';
    CREATE INDEX hub_client_receipts_revocations ON hub_client_receipts(scope_id,(CASE WHEN json_valid(record) THEN json_extract(record,'$.value.result.hubId') END)) WHERE (CASE WHEN json_valid(record) THEN json_extract(record,'$.value.result.kind') END)='revocations';
    CREATE INDEX hub_client_receipts_revocation_cursor ON hub_client_receipts(scope_id) WHERE (CASE WHEN json_valid(record) THEN json_extract(record,'$.value.result.kind') END)='revocations';
    CREATE INDEX memory_entry_support_run ON memory_entry_support(scope_id,(CASE WHEN json_valid(record) THEN json_extract(record,'$.value.source.runId') END),(CASE WHEN json_valid(record) THEN json_extract(record,'$.value.source.attemptId') END));
    CREATE INDEX target_queue_run ON target_queue(scope_id,(CASE WHEN json_valid(record) THEN json_extract(record,'$.request.identity.runId') END),command_id);
    CREATE INDEX target_queue_run_effect ON target_queue(scope_id,(CASE WHEN json_valid(record) THEN json_extract(record,'$.effectCommandIds[3]') END));
    CREATE INDEX target_queue_epoch ON target_queue(target_key,(CASE WHEN json_valid(record) THEN json_extract(record,'$.epoch') END));
    CREATE INDEX target_queue_retry_candidates ON target_queue((CASE WHEN json_valid(record) THEN json_extract(record,'$.request.submittedAt') END),target_key,ordinal) WHERE state='settled' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.outcome') END)='conflict-needs-reattempt' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.reason') END)='PATCH_BASE_ADVANCED' AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.request.deliveryIntent') END) IS NOT NULL;
    CREATE INDEX target_queue_reattempt ON target_queue(scope_id,(CASE WHEN json_valid(record) THEN json_extract(record,'$.request.reattempt.sourceCommandId') END));
    CREATE TABLE IF NOT EXISTS dispatches(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id));
    CREATE INDEX dispatches_run ON dispatches(scope_id,(CASE WHEN json_valid(record) THEN json_extract(record,'$.request.identity.runId') END)) WHERE json_valid(record) AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.terminal') END) IS NULL;
    CREATE TABLE ledger_extensions(namespace TEXT PRIMARY KEY NOT NULL CHECK(length(namespace)>0),version INTEGER NOT NULL CHECK(version>0)) STRICT;`);
  } catch { throw new AttemptStoreError('ATTEMPT_STORE_VERSION'); }
}
