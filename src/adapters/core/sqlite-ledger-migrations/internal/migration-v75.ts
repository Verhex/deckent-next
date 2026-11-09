import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';

/** Owner B1-7/8: one additive upgrade. Caller owns the transaction; existing records stay byte-for-byte unchanged.
 * Old resource keys stay NULL; capacity verifies their JSON as before. Owner: alpha.64 writers ship now; no alpha.63.3 rollback. */
export function migrateLedgerIndexes(db: DatabaseSync): void {
  try { db.exec(`ALTER TABLE model_invocations ADD COLUMN resource_key TEXT REFERENCES capacity_resources(resource_key);
    CREATE INDEX model_invocations_resource_claimed ON model_invocations(resource_key) WHERE state='claimed';
    CREATE INDEX runs_nonterminal ON runs(scope_id,run_id) WHERE json_extract(snapshot,'$.state.kind')!='terminal';
    CREATE INDEX runs_pool ON runs(json_extract(policy,'$.poolId'));
    CREATE INDEX effect_intents_compensates ON effect_intents(scope_id,json_extract(record,'$.intent.command.compensates'),CASE state WHEN 'settled' THEN 0 ELSE 1 END,sequence DESC) WHERE state!='refused';
    CREATE INDEX run_receipts_evaluation ON run_receipts(scope_id,json_extract(command,'$.evaluation.identity.runId'),json_extract(command,'$.evaluation.identity.attemptId'),json_extract(snapshot,'$.revision') DESC) WHERE json_extract(command,'$.action')='apply-task-evaluation';
    CREATE INDEX approvals_pending ON approvals(subject_kind,scope_id,approval_id) WHERE current=1 AND json_extract(snapshot,'$.status')='pending';
    CREATE INDEX hub_client_receipts_revocations ON hub_client_receipts(scope_id,json_extract(record,'$.value.result.hubId')) WHERE json_extract(record,'$.value.result.kind')='revocations';
    CREATE INDEX hub_client_receipts_revocation_cursor ON hub_client_receipts(scope_id) WHERE json_extract(record,'$.value.result.kind')='revocations';
    CREATE INDEX memory_entry_support_run ON memory_entry_support(scope_id,json_extract(record,'$.value.source.runId'),json_extract(record,'$.value.source.attemptId'));
    CREATE INDEX target_queue_run ON target_queue(scope_id,json_extract(record,'$.request.identity.runId'),command_id);
    CREATE INDEX target_queue_run_effect ON target_queue(scope_id,json_extract(record,'$.effectCommandIds[3]'));
    CREATE INDEX target_queue_epoch ON target_queue(target_key,json_extract(record,'$.epoch'));
    CREATE INDEX target_queue_retry_candidates ON target_queue(json_extract(record,'$.request.submittedAt'),target_key,ordinal) WHERE state='settled' AND json_extract(record,'$.outcome')='conflict-needs-reattempt' AND json_extract(record,'$.reason')='PATCH_BASE_ADVANCED' AND json_extract(record,'$.request.deliveryIntent') IS NOT NULL;
    CREATE INDEX target_queue_reattempt ON target_queue(scope_id,json_extract(record,'$.request.reattempt.sourceCommandId'));
    CREATE INDEX dispatches_run ON dispatches(scope_id,json_extract(record,'$.request.identity.runId')) WHERE json_valid(record) AND json_extract(record,'$.terminal') IS NULL;
    CREATE TABLE ledger_extensions(namespace TEXT PRIMARY KEY NOT NULL CHECK(length(namespace)>0),version INTEGER NOT NULL CHECK(version>0)) STRICT;`);
  } catch { throw new AttemptStoreError('ATTEMPT_STORE_VERSION'); }
}
