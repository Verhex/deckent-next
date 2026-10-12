import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';

/** Caller owns the migration transaction: retain all old sealed bytes and refuse a partial upgrade. */
export function migrateRunCreateApprovals(db: DatabaseSync): void {
  try { db.exec(`CREATE TABLE approvals_v52(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,subject_kind TEXT NOT NULL CHECK(subject_kind IN('task','agent-tool-call','operation','config-change','run-create')),
    run_id TEXT,task_id TEXT,action_digest TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(scope_id,approval_id),CHECK((subject_kind='task')=(run_id IS NOT NULL AND task_id IS NOT NULL)));
    INSERT INTO approvals_v52 SELECT scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot,current FROM approvals;
    DROP TABLE approvals; ALTER TABLE approvals_v52 RENAME TO approvals;
    CREATE UNIQUE INDEX approvals_current_action ON approvals(scope_id,run_id,task_id,action_digest) WHERE current=1 AND subject_kind='task';
    CREATE UNIQUE INDEX approvals_current_tool_call ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='agent-tool-call';
    CREATE UNIQUE INDEX approvals_current_operation ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='operation';
    CREATE UNIQUE INDEX approvals_current_config_change ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='config-change';
    CREATE UNIQUE INDEX approvals_current_run_create ON approvals(scope_id,json_extract(snapshot,'$.request.subject.commandId')) WHERE current=1 AND subject_kind='run-create';
    PRAGMA user_version=52;`); }
  catch { throw new AttemptStoreError('ATTEMPT_STORE_VERSION'); }
}
