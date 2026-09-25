/**
 * Turns a current ledger into the exact previous schema (v35): the v36 allocation rebuild is reversed (max_calls NOT NULL again,
 * the checkpoint child rebuilt against it) and the version is set back. A NULL max_calls row makes this fail, as it must.
 */
export const PREVIOUS_LEDGER_VERSION = 35;
export const DOWNGRADE_TO_PREVIOUS_LEDGER_SQL = `PRAGMA defer_foreign_keys=ON;
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
