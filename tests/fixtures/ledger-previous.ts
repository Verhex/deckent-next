/**
 * Previous-schema fixtures. `DOWNGRADE_TO_PREVIOUS_LEDGER_SQL` retains the historical v50 target.
 * It removes v53 proposal tables, restores the v51 approval CHECK (run-create rows refuse downgrade),
 * then removes the v51 acceptance metrics table and index. `DOWNGRADE_TO_V49_LEDGER_SQL` also removes the
 * v50 unreconciled-held-spend index. `DOWNGRADE_TO_V48_LEDGER_SQL` also goes back to v48 (v49 adds measured-tariff spending and append-only management receipts). v47→v48 only
 * widened the approvals subject CHECK to `config-change`, so the rebuild back to three values is exact — a config-change row makes it fail, as it
 * must. `DOWNGRADE_TO_V46_LEDGER_SQL` also drops the v47 capacity override and receipt tables. V45 additionally drops the two v46 decision tables. `DOWNGRADE_TO_V44_LEDGER_SQL` also reverts
 * the v45 (A1/A3) Run snapshot v4 -> v3 change (exact for ledgers whose Runs were never parked/closed).
 * `DOWNGRADE_TO_V43_LEDGER_SQL` also drops the two execution pool hold tables (v43 -> v44 only
 * added the two execution pool hold tables, so dropping them is exact); `DOWNGRADE_TO_V42_LEDGER_SQL` also drops the four v43 model
 * catalog tables (exact for the same reason); `DOWNGRADE_TO_V41_LEDGER_SQL` also goes back to v41 (v42 changed
 * only the adoption record contract, so the version alone goes back — exact for a ledger without v2 adoption records, which a test
 * writes in the v1 form itself); `DOWNGRADE_TO_V40_LEDGER_SQL` also removes the v41 audit tables and their append-only triggers;
 * `DOWNGRADE_TO_V39_LEDGER_SQL` also reverses the v40 approvals rebuild to the
 * two-value subject CHECK (an operation approval row makes it fail, as it must); `DOWNGRADE_TO_V38_LEDGER_SQL` also removes the v39
 * scope registry and companies tables; `DOWNGRADE_TO_V37_LEDGER_SQL` also rebuilds the v38 operation-keyed approvals table back to
 * task-only columns (a tool-call approval row makes it fail); `DOWNGRADE_TO_V36_LEDGER_SQL` also removes the v37 agent turn tables;
 * `DOWNGRADE_TO_V35_LEDGER_SQL` goes one step further and reverses the v36 allocation rebuild (max_calls NOT NULL again, the
 * checkpoint child rebuilt against it).
 */
export const PREVIOUS_LEDGER_VERSION = 50;
/** v58 → v57: the adoption journal back to one sequence per ref name (no repository column, settled 0/1). A released row, or two
 * repositories' rows of one target at the same sequence, makes it fail, as it must; restoring the pre-switch backup is the real path. */
/** v59 → v58 (PRE-7): v59 widened only record vocabularies (environment park, `not-run` acceptance), so the version alone goes back —
 * exact for a ledger that holds none of them; restoring the pre-switch backup is the real path. */
/** v64 → v63 (S7 agent/skill catalog): the additive catalog tables (and with them their indexes and triggers) are dropped; exact for a ledger
 * without catalog rows; restoring the pre-switch backup is the real path. */
export const DOWNGRADE_TO_V63_LEDGER_SQL = 'DROP TABLE agent_catalog_receipts; DROP TABLE skill_definition_revisions; DROP TABLE skill_definitions; '
  + 'DROP TABLE agent_definition_revisions; DROP TABLE agent_definitions; PRAGMA user_version=63;';
/** v63 → v62 (S6R-1 effect producer): the producer-Attempt index is dropped; intents keep their recorded producer (an older build refuses the
 * new records), so this is exact for a ledger without producer-bearing intents; restoring the pre-switch backup is the real path. */
export const DOWNGRADE_TO_V62_LEDGER_SQL = DOWNGRADE_TO_V63_LEDGER_SQL + ' DROP INDEX effect_intents_producer_attempt; PRAGMA user_version=62;';
/** v62 → v61 (ATAMA-1): v62 widened only record contracts (work input v2, sealed assignment), so the version alone goes back — exact for a
 * ledger that holds none of them; restoring the pre-switch backup is the real path. */
export const DOWNGRADE_TO_V61_LEDGER_SQL = DOWNGRADE_TO_V62_LEDGER_SQL + ' PRAGMA user_version=61;';
/** v61 → v60 (S4 memory journal): the additive memory tables are dropped; restoring the pre-switch backup is the real path. */
export const DOWNGRADE_TO_V60_LEDGER_SQL = DOWNGRADE_TO_V61_LEDGER_SQL + ' DROP TABLE memory_search; DROP TABLE memory_command_receipts; DROP TABLE memory_entry_revisions; DROP TABLE memory_entries; PRAGMA user_version=60;';
/** v60 → v59 (ATAMA-0): the metrics table back to the producer-only key without `superseded_by`; rowids kept. Two outcome kinds of one producer
 * make it fail, as they must; restoring the pre-switch backup is the real path. */
export const DOWNGRADE_TO_V59_LEDGER_SQL = `${DOWNGRADE_TO_V60_LEDGER_SQL} CREATE TABLE acceptance_metrics_v59(scope_id TEXT NOT NULL, producer_command_id TEXT NOT NULL, run_id TEXT NOT NULL,
    task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, outcome_kind TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(scope_id,producer_command_id));
  INSERT INTO acceptance_metrics_v59(rowid,scope_id,producer_command_id,run_id,task_id,attempt_id,outcome_kind,record)
    SELECT rowid,scope_id,producer_command_id,run_id,task_id,attempt_id,outcome_kind,record FROM acceptance_metrics ORDER BY rowid;
  DROP TABLE acceptance_metrics; ALTER TABLE acceptance_metrics_v59 RENAME TO acceptance_metrics;
  CREATE INDEX acceptance_metrics_attempt ON acceptance_metrics(scope_id,run_id,task_id,attempt_id,outcome_kind); PRAGMA user_version=59;`;
export const DOWNGRADE_TO_V58_LEDGER_SQL = `${DOWNGRADE_TO_V59_LEDGER_SQL} PRAGMA user_version=58;`;
export const DOWNGRADE_TO_V57_LEDGER_SQL = `${DOWNGRADE_TO_V58_LEDGER_SQL} CREATE TABLE workspace_adoptions_v57(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,target_ref TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence>0),kind TEXT NOT NULL CHECK(kind IN('adopt','rollback')),intent TEXT NOT NULL,
    settled INTEGER NOT NULL CHECK(settled IN(0,1)),PRIMARY KEY(scope_id,command_id),UNIQUE(target_ref,sequence));
  INSERT INTO workspace_adoptions_v57 SELECT scope_id,command_id,target_ref,sequence,kind,intent,settled FROM workspace_adoptions;
  DROP TABLE workspace_adoptions; ALTER TABLE workspace_adoptions_v57 RENAME TO workspace_adoptions; PRAGMA user_version=57;`;
export const DOWNGRADE_TO_V56_LEDGER_SQL = `${DOWNGRADE_TO_V57_LEDGER_SQL} DROP TABLE target_queue_events; DROP TABLE target_queue; PRAGMA user_version=56;`;
export const DOWNGRADE_TO_V55_LEDGER_SQL = `${DOWNGRADE_TO_V56_LEDGER_SQL} DROP TABLE audit_checkpoints; PRAGMA user_version=55;`;
export const DOWNGRADE_TO_V54_LEDGER_SQL = `${DOWNGRADE_TO_V55_LEDGER_SQL} DROP TABLE model_invocation_plan_usage; PRAGMA user_version=54;`;
export const DOWNGRADE_TO_V53_LEDGER_SQL = `${DOWNGRADE_TO_V54_LEDGER_SQL} DROP TRIGGER run_quota_waits_insert; DROP TRIGGER run_quota_waits_update; DROP TRIGGER run_quota_waits_delete; DROP TABLE run_quota_waits; DROP TABLE quota_release_receipts; PRAGMA user_version=53;`;
export const DOWNGRADE_TO_V52_LEDGER_SQL = `${DOWNGRADE_TO_V53_LEDGER_SQL} DROP TABLE run_proposal_receipts; DROP TABLE run_proposals; PRAGMA user_version=52;`;
export const DOWNGRADE_TO_V51_LEDGER_SQL = `${DOWNGRADE_TO_V52_LEDGER_SQL} CREATE TABLE approvals_v51(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,subject_kind TEXT NOT NULL CHECK(subject_kind IN('task','agent-tool-call','operation','config-change')),
  run_id TEXT,task_id TEXT,action_digest TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(scope_id,approval_id),CHECK((subject_kind='task')=(run_id IS NOT NULL AND task_id IS NOT NULL)));
  INSERT INTO approvals_v51 SELECT scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot,current FROM approvals;
  DROP TABLE approvals; ALTER TABLE approvals_v51 RENAME TO approvals;
  CREATE UNIQUE INDEX approvals_current_action ON approvals(scope_id,run_id,task_id,action_digest) WHERE current=1 AND subject_kind='task';
  CREATE UNIQUE INDEX approvals_current_tool_call ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='agent-tool-call';
  CREATE UNIQUE INDEX approvals_current_operation ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='operation';
  CREATE UNIQUE INDEX approvals_current_config_change ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='config-change'; PRAGMA user_version=51;`;
export const DOWNGRADE_TO_V50_LEDGER_SQL = `${DOWNGRADE_TO_V51_LEDGER_SQL} DROP INDEX acceptance_metrics_attempt; DROP TABLE acceptance_metrics; PRAGMA user_version=50;`;
export const DOWNGRADE_TO_PREVIOUS_LEDGER_SQL = DOWNGRADE_TO_V50_LEDGER_SQL;
export const DOWNGRADE_TO_V49_LEDGER_SQL = `${DOWNGRADE_TO_V50_LEDGER_SQL} DROP INDEX model_invocation_spend_unreconciled_holds; PRAGMA user_version=49;`;
export const DOWNGRADE_TO_V48_LEDGER_SQL = `${DOWNGRADE_TO_V49_LEDGER_SQL} DROP TRIGGER IF EXISTS provider_spend_management_no_update; DROP TRIGGER IF EXISTS provider_spend_management_no_delete; DROP TABLE provider_spend_management; PRAGMA user_version=48;`;
export const DOWNGRADE_TO_V47_LEDGER_SQL = `${DOWNGRADE_TO_V48_LEDGER_SQL} CREATE TABLE approvals_v47(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,subject_kind TEXT NOT NULL CHECK(subject_kind IN('task','agent-tool-call','operation')),
    run_id TEXT,task_id TEXT,action_digest TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(scope_id,approval_id),CHECK((subject_kind='task')=(run_id IS NOT NULL AND task_id IS NOT NULL)));
  INSERT INTO approvals_v47 SELECT scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot,current FROM approvals;
  DROP TABLE approvals; ALTER TABLE approvals_v47 RENAME TO approvals;
  CREATE UNIQUE INDEX approvals_current_action ON approvals(scope_id,run_id,task_id,action_digest) WHERE current=1 AND subject_kind='task';
  CREATE UNIQUE INDEX approvals_current_tool_call ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='agent-tool-call';
  CREATE UNIQUE INDEX approvals_current_operation ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='operation'; PRAGMA user_version=47;`;
export const DOWNGRADE_TO_V46_LEDGER_SQL = `${DOWNGRADE_TO_V47_LEDGER_SQL} DROP TABLE execution_pool_capacity_receipts; DROP TABLE execution_pool_capacities; PRAGMA user_version=46;`;
export const DOWNGRADE_TO_V45_LEDGER_SQL = `${DOWNGRADE_TO_V46_LEDGER_SQL} DROP TABLE decision_command_receipts; DROP TABLE decision_cases; PRAGMA user_version=45;`;
export const DOWNGRADE_TO_V44_LEDGER_SQL = `${DOWNGRADE_TO_V45_LEDGER_SQL} UPDATE runs SET snapshot=json_remove(json_set(snapshot,'$.schemaVersion',3),'$.state');
  UPDATE run_receipts SET snapshot=json_remove(json_set(snapshot,'$.schemaVersion',3),'$.state'); PRAGMA user_version=44;`;
export const DOWNGRADE_TO_V43_LEDGER_SQL = `${DOWNGRADE_TO_V44_LEDGER_SQL} DROP TABLE execution_pool_hold_receipts; DROP TABLE execution_pool_holds; PRAGMA user_version=43;`;
export const DOWNGRADE_TO_V42_LEDGER_SQL = `${DOWNGRADE_TO_V43_LEDGER_SQL} DROP TABLE model_catalog_receipts; DROP TABLE model_catalog_activations;
  DROP TABLE model_catalog_models; DROP TABLE model_catalog_channels; PRAGMA user_version=42;`;
export const DOWNGRADE_TO_V41_LEDGER_SQL = `${DOWNGRADE_TO_V42_LEDGER_SQL} PRAGMA user_version=41;`;
export const DOWNGRADE_TO_V40_LEDGER_SQL = `${DOWNGRADE_TO_V41_LEDGER_SQL} DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete;
  DROP TABLE audit_counters; DROP TABLE audit_events; PRAGMA user_version=40;`;
export const DOWNGRADE_TO_V39_LEDGER_SQL = `${DOWNGRADE_TO_V40_LEDGER_SQL} CREATE TABLE approvals_v39(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,subject_kind TEXT NOT NULL CHECK(subject_kind IN('task','agent-tool-call')),
    run_id TEXT,task_id TEXT,action_digest TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(scope_id,approval_id),CHECK((subject_kind='task')=(run_id IS NOT NULL AND task_id IS NOT NULL)));
  INSERT INTO approvals_v39 SELECT scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot,current FROM approvals;
  DROP TABLE approvals; ALTER TABLE approvals_v39 RENAME TO approvals;
  CREATE UNIQUE INDEX approvals_current_action ON approvals(scope_id,run_id,task_id,action_digest) WHERE current=1 AND subject_kind='task';
  CREATE UNIQUE INDEX approvals_current_tool_call ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='agent-tool-call'; PRAGMA user_version=39;`;
export const DOWNGRADE_TO_V38_LEDGER_SQL = `${DOWNGRADE_TO_V39_LEDGER_SQL} DROP TABLE scope_registry; DROP TABLE companies; PRAGMA user_version=38;`;
export const DOWNGRADE_TO_V37_LEDGER_SQL = `${DOWNGRADE_TO_V38_LEDGER_SQL} CREATE TABLE approvals_v37(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,action_digest TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(scope_id,approval_id));
  INSERT INTO approvals_v37 SELECT scope_id,approval_id,run_id,task_id,action_digest,revision,snapshot,current FROM approvals;
  DROP TABLE approvals; ALTER TABLE approvals_v37 RENAME TO approvals;
  CREATE UNIQUE INDEX approvals_current_action ON approvals(scope_id,run_id,task_id,action_digest) WHERE current=1; PRAGMA user_version=37;`;
export const DOWNGRADE_TO_V36_LEDGER_SQL = `${DOWNGRADE_TO_V37_LEDGER_SQL} DROP TABLE agent_turn_tool_calls; DROP TABLE agent_turns; PRAGMA user_version=36;`;
export const DOWNGRADE_TO_V35_LEDGER_SQL = `${DOWNGRADE_TO_V36_LEDGER_SQL} PRAGMA defer_foreign_keys=ON;
  CREATE TABLE model_invocation_allocations_v35(scope_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
  max_calls INTEGER NOT NULL,max_in_flight INTEGER NOT NULL,lifetime_calls INTEGER NOT NULL,in_flight INTEGER NOT NULL,
  record TEXT NOT NULL,PRIMARY KEY(scope_id,allocation_id));
  INSERT INTO model_invocation_allocations_v35 SELECT scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record FROM model_invocation_allocations;
  CREATE TABLE model_invocation_allocation_checkpoints_v35(scope_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=1),digest TEXT NOT NULL,PRIMARY KEY(scope_id,allocation_id),
    FOREIGN KEY(scope_id,allocation_id) REFERENCES model_invocation_allocations_v35(scope_id,allocation_id));
  INSERT INTO model_invocation_allocation_checkpoints_v35 SELECT scope_id,allocation_id,revision,digest FROM model_invocation_allocation_checkpoints;
  DROP TABLE model_invocation_allocation_checkpoints; DROP TABLE model_invocation_allocations;
  ALTER TABLE model_invocation_allocations_v35 RENAME TO model_invocation_allocations;
  ALTER TABLE model_invocation_allocation_checkpoints_v35 RENAME TO model_invocation_allocation_checkpoints; PRAGMA user_version=35;`;
