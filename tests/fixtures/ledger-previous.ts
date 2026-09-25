/**
 * Previous-schema fixtures. `DOWNGRADE_TO_PREVIOUS_LEDGER_SQL` turns a current ledger into the exact previous schema (v36: the agent
 * turn tables of v37 removed); `DOWNGRADE_TO_V35_LEDGER_SQL` goes one step further and reverses the v36 allocation rebuild
 * (max_calls NOT NULL again, the checkpoint child rebuilt against it). A NULL max_calls row makes the v35 step fail, as it must.
 */
export const PREVIOUS_LEDGER_VERSION = 36;
export const DOWNGRADE_TO_PREVIOUS_LEDGER_SQL = `DROP TABLE agent_turn_tool_calls; DROP TABLE agent_turns; PRAGMA user_version=36;`;
export const DOWNGRADE_TO_V35_LEDGER_SQL = `${DOWNGRADE_TO_PREVIOUS_LEDGER_SQL} PRAGMA defer_foreign_keys=ON;
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
