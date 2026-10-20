import { migrateAuditCheckpoints } from './migration-v56.js';
import { migrateQuotaWaits } from './migration-v54.js';
import { migrateRunCreateApprovals } from './migration-v52.js';
import { migrateMeasuredTariffSpend } from './migration-v49.js';
import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError, type SupervisorProfileValidator } from '#engine/index.js';
import { requireLedgerV5Custody } from './migration-v5.js';
import { requireLedgerV6ProfileCompatibility } from './migration-v6.js';
import { requireLedgerV8ExecutionRegistry } from './migration-v8.js';
import { migrateImmediateEligibility } from './migration-v12.js';
import { migrateModelInvocationEvidence } from './migration-v15.js';
import { migrateModelInvocationContents } from './migration-v16.js';
import { migrateModelInvocationPurge } from './migration-v17.js';
import { migrateModelInvocationControl } from './migration-v18.js';
import { migrateModelAllocationCheckpoints } from './migration-v19.js';
import { migrateProviderSpend } from './migration-v20.js';
import { migrateProviderReportedSpend } from './migration-v21.js';
import { migrateScopeRegistry } from './migration-v39.js';
import { migrateAuditEvents } from './migration-v41.js';
import { migrateAdoptionVerification } from './migration-v42.js';
import { migrateModelCatalog } from './migration-v43.js';
import { migratePoolCapacity } from './migration-v47.js';
import { migrateExecutionPoolHolds } from './migration-v44.js';
import { migrateRunParking } from './migration-v45.js';
import { migrateDecisionPort } from './migration-v46.js';
import { getConfigFieldDefault } from '#platform/index.js';
// Persisted Next schema history. Versions are protocol invariants, not customer configuration.
export const DISPATCH_LEDGER_VERSION = 8;
// Minimum readable Run shape; earlier ledgers need the explicit writer migration.
export const RUN_LEDGER_VERSION = 12;
export const SERVICE_SHUTDOWN_LEDGER_VERSION = 10;
export const INSTALLATION_OWNERSHIP_LEDGER_VERSION = 11;
export const IMMEDIATE_ELIGIBILITY_LEDGER_VERSION = 12;
export const MODEL_ACTIVATION_LEDGER_VERSION = 13;
export const MODEL_INVOCATION_LEDGER_VERSION = 18;
export const MODEL_ALLOCATION_LEDGER_VERSION = 19;
export const PROVIDER_SPEND_LEDGER_VERSION = 21;
export const PROVIDER_SPEND_AUDIT_LEDGER_VERSION = 22;
// Current durable contract; older writers must not reopen newer records.
export const CURRENT_LEDGER_VERSION = 59;
// PRE-7 ORTAM-HAZIR: environment park + `not-run` acceptance vocabularies (Run park reason and its requirement as failure code, a
// `launch-refused` previous binding, the launch refusal's `requirement`, report evidence `not-run`, task reason `acceptance-check-not-run`).
// Additive: every v58 record already parses under the widened contracts, so no row is read or rewritten; the version step alone keeps an
// older build (which refuses a newer ledger) from reading the new vocabulary. Downgrade = restore the pre-switch backup.
export const ENVIRONMENT_READINESS_LEDGER_VERSION = 59;
// BENIMSEME-DEPO-KIMLIGI: adoptions numbered per (repository, target); pre-v58 rows stamped 'pre-v58'; settled 2 = released as not applied.
export const ADOPTION_REPOSITORY_LEDGER_VERSION = 58;
export const MODEL_INVOCATION_PLAN_USAGE_LEDGER_VERSION = 55;
// ONAY-GUVENCE D2: chained audit checkpoints (additive; lane v55, renumbered to v56 at the pre-beta wave integration).
export const AUDIT_CHECKPOINT_LEDGER_VERSION = 56;
export const RUN_PROPOSAL_LEDGER_VERSION = 53;
export const POOL_CAPACITY_LEDGER_VERSION = 47;
// T3 L2 CONFIG-APPROVAL: the `config-change` approval subject (approvals CHECK widened, one current row per (scope, digest)).
export const CONFIG_CHANGE_APPROVAL_LEDGER_VERSION = 48;
export const SCOPE_REGISTRY_LEDGER_VERSION = 39;
export const OPERATION_APPROVAL_LEDGER_VERSION = 40;
export const AUDIT_EVENT_LEDGER_VERSION = 41;
// B06-2b: adoption intent v2 (verification binding); exact v1 adopt records are rewritten, the table is unchanged.
export const ADOPTION_VERIFICATION_LEDGER_VERSION = 42;
// WORKER-CURRENCY-1: ledger model catalog (channel + exact model id facts, scoped hierarchical activation, receipts).
export const MODEL_CATALOG_LEDGER_VERSION = 43;
// K5: typed execution pool hold (one row per pool + per-scope command receipts); additive.
export const POOL_HOLD_LEDGER_VERSION = 44;
export const RUN_PARKING_LEDGER_VERSION = 45;
// AOF-DECISION-PORT: sealed decision cases and command receipts; additive (lane v45, renumbered at batch-27 integration).
export const DECISION_PORT_LEDGER_VERSION = 46;
export const INTEGRATION_LEDGER_VERSION = 30;
// Sealed worker event logs (table since v35); read-only readers require it before reading a log.
export const WORKER_EVENT_LOG_LEDGER_VERSION = 35;
const migrations: Readonly<Record<number, string>> = Object.freeze({
  59: 'PRAGMA user_version=59;',
  // Table rebuild (UNIQUE and CHECK change): every row is kept byte for byte with repository 'pre-v58'. Downgrade = restore the pre-switch backup.
  58: `CREATE TABLE workspace_adoptions_v58(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,repository TEXT NOT NULL,target_ref TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence>0),kind TEXT NOT NULL CHECK(kind IN('adopt','rollback')),intent TEXT NOT NULL,
    settled INTEGER NOT NULL CHECK(settled IN(0,1,2)),PRIMARY KEY(scope_id,command_id));
    INSERT INTO workspace_adoptions_v58 SELECT scope_id,command_id,'pre-v58',target_ref,sequence,kind,intent,settled FROM workspace_adoptions;
    DROP TABLE workspace_adoptions; ALTER TABLE workspace_adoptions_v58 RENAME TO workspace_adoptions;
    CREATE UNIQUE INDEX workspace_adoptions_sequence ON workspace_adoptions(repository,target_ref,sequence) WHERE settled<2; PRAGMA user_version=58;`,
  // Additive target queue: no backfill invents source custody for historical effects. Restore the pre-switch backup to roll back.
  57: `CREATE TABLE target_queue(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,target_key TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>0),
    revision INTEGER NOT NULL CHECK(revision>=0),state TEXT NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,command_id),UNIQUE(target_key,ordinal));
    CREATE INDEX target_queue_open ON target_queue(target_key,ordinal) WHERE state NOT IN('settled','cancelled','expired','parked');
    CREATE TABLE target_queue_events(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,command_id,revision),FOREIGN KEY(scope_id,command_id) REFERENCES target_queue(scope_id,command_id));
    CREATE TRIGGER target_queue_events_no_update BEFORE UPDATE ON target_queue_events BEGIN SELECT RAISE(ABORT,'QUEUE_APPEND_ONLY'); END;
    CREATE TRIGGER target_queue_events_no_delete BEFORE DELETE ON target_queue_events BEGIN SELECT RAISE(ABORT,'QUEUE_APPEND_ONLY'); END;
    PRAGMA user_version=57;`,
  55: `CREATE TABLE model_invocation_plan_usage(scope_id TEXT NOT NULL,invocation_id TEXT NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,
    PRIMARY KEY(scope_id,invocation_id));
    CREATE TRIGGER model_invocation_plan_usage_no_update BEFORE UPDATE ON model_invocation_plan_usage BEGIN SELECT RAISE(ABORT,'PLAN_USAGE_APPEND_ONLY'); END;
    CREATE TRIGGER model_invocation_plan_usage_no_delete BEFORE DELETE ON model_invocation_plan_usage BEGIN SELECT RAISE(ABORT,'PLAN_USAGE_APPEND_ONLY'); END;
    PRAGMA user_version=55;`,
  53: `CREATE TABLE run_proposals(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,proposal_id TEXT NOT NULL,run_id TEXT NOT NULL,
    revision INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id),UNIQUE(scope_id,proposal_id));
    CREATE TABLE run_proposal_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,command_id,revision));
    CREATE TRIGGER run_proposal_receipts_no_update BEFORE UPDATE ON run_proposal_receipts BEGIN SELECT RAISE(ABORT,'RUN_PROPOSAL_APPEND_ONLY'); END;
    CREATE TRIGGER run_proposal_receipts_no_delete BEFORE DELETE ON run_proposal_receipts BEGIN SELECT RAISE(ABORT,'RUN_PROPOSAL_APPEND_ONLY'); END;
    PRAGMA user_version=53;`,
  51: `CREATE TABLE acceptance_metrics(scope_id TEXT NOT NULL, producer_command_id TEXT NOT NULL, run_id TEXT NOT NULL,
    task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, outcome_kind TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(scope_id,producer_command_id));
    CREATE INDEX acceptance_metrics_attempt ON acceptance_metrics(scope_id,run_id,task_id,attempt_id,outcome_kind); PRAGMA user_version=51;`,
  50: `CREATE INDEX model_invocation_spend_unreconciled_holds ON model_invocation_spend_reservations(scope_id,invocation_id COLLATE BINARY)
    WHERE json_extract(record,'$.disposition.state')='held' AND json_extract(record,'$.reconciliation') IS NULL;
    PRAGMA user_version=50;`,
  // 44 (execution pool hold, K5): `migrateExecutionPoolHolds` in migration-v44.ts, dispatched below like v43.
  // 43 (ledger model catalog, WORKER-CURRENCY-1): `migrateModelCatalog` in migration-v43.ts, dispatched below like v41.
  // 41 (audit events, general Core audit port): `migrateAuditEvents` in migration-v41.ts, dispatched below like v39.
  // T3 L2 CONFIG-APPROVAL: a policy `require-approval` on a config write opens a `config-change` approval. As in v40, SQLite cannot widen a
  // CHECK in place: `approvals` is rebuilt row for row (every task, tool-call and operation row and its sealed snapshot unchanged), the v40
  // indexes are recreated and config changes get their own (scope, digest) index.
  48: `CREATE TABLE approvals_v48(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,subject_kind TEXT NOT NULL CHECK(subject_kind IN('task','agent-tool-call','operation','config-change')),
    run_id TEXT,task_id TEXT,action_digest TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(scope_id,approval_id),CHECK((subject_kind='task')=(run_id IS NOT NULL AND task_id IS NOT NULL)));
    INSERT INTO approvals_v48(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot,current)
      SELECT scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot,current FROM approvals;
    DROP TABLE approvals; ALTER TABLE approvals_v48 RENAME TO approvals;
    CREATE UNIQUE INDEX approvals_current_action ON approvals(scope_id,run_id,task_id,action_digest) WHERE current=1 AND subject_kind='task';
    CREATE UNIQUE INDEX approvals_current_tool_call ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='agent-tool-call';
    CREATE UNIQUE INDEX approvals_current_operation ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='operation';
    CREATE UNIQUE INDEX approvals_current_config_change ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='config-change';
    PRAGMA user_version=48;`,
  // C12 G1: catalog operation approvals. SQLite cannot widen a CHECK in place, so `approvals` is rebuilt row for row (every task and
  // tool-call row and its sealed snapshot unchanged), the v38 indexes are recreated and operations get their own (scope, digest) index.
  40: `CREATE TABLE approvals_v40(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,subject_kind TEXT NOT NULL CHECK(subject_kind IN('task','agent-tool-call','operation')),
    run_id TEXT,task_id TEXT,action_digest TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(scope_id,approval_id),CHECK((subject_kind='task')=(run_id IS NOT NULL AND task_id IS NOT NULL)));
    INSERT INTO approvals_v40(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot,current)
      SELECT scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot,current FROM approvals;
    DROP TABLE approvals; ALTER TABLE approvals_v40 RENAME TO approvals;
    CREATE UNIQUE INDEX approvals_current_action ON approvals(scope_id,run_id,task_id,action_digest) WHERE current=1 AND subject_kind='task';
    CREATE UNIQUE INDEX approvals_current_tool_call ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='agent-tool-call';
    CREATE UNIQUE INDEX approvals_current_operation ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='operation';
    PRAGMA user_version=40;`,
  // Terminal agent turns (T-L3): one row per (scope, turn) — the durable identity a replay or reconnect meets — and one row per
  // settled tool call as an audit projection (effectful tools will reference their C11 intent from it).
  // C12: operation-keyed approvals. Task approvals keep their columns and index; agent tool calls bind (scope, action digest).
  38: `CREATE TABLE approvals_v38(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,subject_kind TEXT NOT NULL CHECK(subject_kind IN('task','agent-tool-call')),
    run_id TEXT,task_id TEXT,action_digest TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(scope_id,approval_id),CHECK((subject_kind='task')=(run_id IS NOT NULL AND task_id IS NOT NULL)));
    INSERT INTO approvals_v38(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot,current)
      SELECT scope_id,approval_id,'task',run_id,task_id,action_digest,revision,snapshot,current FROM approvals;
    DROP TABLE approvals; ALTER TABLE approvals_v38 RENAME TO approvals;
    CREATE UNIQUE INDEX approvals_current_action ON approvals(scope_id,run_id,task_id,action_digest) WHERE current=1 AND subject_kind='task';
    CREATE UNIQUE INDEX approvals_current_tool_call ON approvals(scope_id,action_digest) WHERE current=1 AND subject_kind='agent-tool-call';
    PRAGMA user_version=38;`,
  37: `CREATE TABLE agent_turns(scope_id TEXT NOT NULL,turn_id TEXT NOT NULL,principal_key TEXT NOT NULL,request_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','finished')),record TEXT NOT NULL,PRIMARY KEY(scope_id,turn_id));
    CREATE TABLE agent_turn_tool_calls(scope_id TEXT NOT NULL,turn_id TEXT NOT NULL,round INTEGER NOT NULL CHECK(round>=1),
    call_index INTEGER NOT NULL CHECK(call_index>=0),record TEXT NOT NULL,PRIMARY KEY(scope_id,turn_id,round,call_index),
    FOREIGN KEY(scope_id,turn_id) REFERENCES agent_turns(scope_id,turn_id)); PRAGMA user_version=37;`,
  // Allocation without a lifetime total (owner 2026-09-25, local terminal profile): max_calls may be NULL, meaning no lifetime cap;
  // concurrency (max_in_flight) stays mandatory. SQLite cannot drop NOT NULL in place, so the parent table and its only child
  // (allocation checkpoints, v19) are rebuilt row for row with deferred foreign keys; renaming the parent rewrites the child's
  // reference to the final name.
  36: `PRAGMA defer_foreign_keys=ON;
    CREATE TABLE model_invocation_allocations_v36(scope_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
    max_calls INTEGER CHECK(max_calls IS NULL OR max_calls>0),max_in_flight INTEGER NOT NULL,lifetime_calls INTEGER NOT NULL,in_flight INTEGER NOT NULL,
    record TEXT NOT NULL,PRIMARY KEY(scope_id,allocation_id));
    INSERT INTO model_invocation_allocations_v36(scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record)
      SELECT scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record FROM model_invocation_allocations;
    CREATE TABLE model_invocation_allocation_checkpoints_v36(scope_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>=1),digest TEXT NOT NULL,PRIMARY KEY(scope_id,allocation_id),
      FOREIGN KEY(scope_id,allocation_id) REFERENCES model_invocation_allocations_v36(scope_id,allocation_id));
    INSERT INTO model_invocation_allocation_checkpoints_v36(scope_id,allocation_id,revision,digest)
      SELECT scope_id,allocation_id,revision,digest FROM model_invocation_allocation_checkpoints;
    DROP TABLE model_invocation_allocation_checkpoints;
    DROP TABLE model_invocation_allocations;
    ALTER TABLE model_invocation_allocations_v36 RENAME TO model_invocation_allocations;
    ALTER TABLE model_invocation_allocation_checkpoints_v36 RENAME TO model_invocation_allocation_checkpoints; PRAGMA user_version=36;`,
  // Sealed worker-reported event logs (B09): artifact receipt of the redacted events plus the deterministic summary.
  35: `CREATE TABLE worker_event_logs(scope_id TEXT NOT NULL,attempt_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,attempt_id)); PRAGMA user_version=35;`,
  // Generic effect intents (C11): one row per operation command; sequence orders intents per external target record.
  34: `CREATE TABLE effect_intents(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence>0),idempotency_key_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('claimed','settled','unknown','refused')),
    record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id),UNIQUE(scope_id,idempotency_key_hash),UNIQUE(target_kind,target_id,sequence)); PRAGMA user_version=34;`,
  // Branch adoption/rollback intents. sequence is the per-target fence; state 0 = claimed (Git effect may be pending), 1 = settled.
  33: `CREATE TABLE workspace_adoptions(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,target_ref TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence>0),kind TEXT NOT NULL CHECK(kind IN('adopt','rollback')),intent TEXT NOT NULL,
    settled INTEGER NOT NULL CHECK(settled IN(0,1)),PRIMARY KEY(scope_id,command_id),UNIQUE(target_ref,sequence)); PRAGMA user_version=33;`,
  32: `CREATE TABLE workspace_deliveries(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,
    intent TEXT NOT NULL,delivered INTEGER NOT NULL CHECK(delivered IN(0,1)),PRIMARY KEY(scope_id,command_id)); PRAGMA user_version=32;`,
  31: `CREATE TABLE approvals(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,action_digest TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(scope_id,approval_id));
    CREATE UNIQUE INDEX approvals_current_action ON approvals(scope_id,run_id,task_id,action_digest) WHERE current=1;
    CREATE TABLE approval_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,
    snapshot TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));
    CREATE TABLE approval_outbox(scope_id TEXT NOT NULL,approval_id TEXT NOT NULL,revision INTEGER NOT NULL,
    snapshot TEXT NOT NULL,PRIMARY KEY(scope_id,approval_id,revision)); PRAGMA user_version=31;`,
  30: `CREATE TABLE workspace_integrations(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,intent TEXT NOT NULL,manifest TEXT,
    PRIMARY KEY(scope_id,command_id)); PRAGMA user_version=30;`,
  // Immutable host-produced workspace patch receipt in the existing dispatch record.
  29: 'PRAGMA user_version=29;',
  // Explicit named artifact selectors in task inputs and pinned supervisor bindings.
  28: 'PRAGMA user_version=28;',
  // Named output-file declarations and retained artifact references.
  27: 'PRAGMA user_version=27;',
  // Optional Task input declarations and pinned Docker read-only input bindings.
  26: 'PRAGMA user_version=26;',
  25: `CREATE TABLE run_execution_intents(scope_id TEXT NOT NULL,run_id TEXT NOT NULL,actor_id TEXT NOT NULL,
    issuer TEXT NOT NULL,subject TEXT NOT NULL,admitted_at INTEGER NOT NULL,command_id TEXT NOT NULL,
    PRIMARY KEY(scope_id,run_id), UNIQUE(scope_id,command_id));
    CREATE INDEX run_execution_intents_actor ON run_execution_intents(actor_id,issuer,subject,scope_id,run_id);
    CREATE TABLE task_evaluation_observations(scope_id TEXT NOT NULL,run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
    attempt_revision INTEGER NOT NULL CHECK(attempt_revision>0),PRIMARY KEY(scope_id,run_id,attempt_id,attempt_revision));
    INSERT INTO task_evaluation_observations
      SELECT DISTINCT scope_id,json_extract(command,'$.evaluation.identity.runId'),json_extract(command,'$.evaluation.identity.attemptId'),
      json_extract(command,'$.evaluation.attemptRevision') FROM run_receipts
      WHERE json_extract(command,'$.action')='apply-task-evaluation';
    PRAGMA user_version=25;`,
  // Partial reservation semantics: older writers/readers must not open this ledger.
  24: 'PRAGMA user_version=24;',
  23: 'PRAGMA user_version=23;',
  1: `CREATE TABLE attempts(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision INTEGER NOT NULL,
    snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id));
    CREATE TABLE attempt_receipts(scope_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL,
    snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, command_id)); PRAGMA user_version=1;`,
  2: 'CREATE TABLE dispatches(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id)); PRAGMA user_version=2;',
  3: `CREATE TABLE runs(scope_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, policy TEXT NOT NULL, PRIMARY KEY(scope_id,run_id));
    CREATE TABLE run_receipts(scope_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(scope_id,command_id)); PRAGMA user_version=3;`,
  4: 'CREATE TABLE execution_pools(pool_id TEXT PRIMARY KEY NOT NULL, policy TEXT NOT NULL); PRAGMA user_version=4;',
  7: 'CREATE TABLE cancellation_deliveries(scope_id TEXT NOT NULL,attempt_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,attempt_id)); PRAGMA user_version=7;',
  9: 'CREATE TABLE run_workspace_custody(scope_id TEXT NOT NULL,run_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,run_id)); PRAGMA user_version=9;',
  10: `CREATE TABLE service_shutdown_commands(scope_id TEXT NOT NULL,service_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,service_id,command_id));
    CREATE TABLE service_shutdown_outcomes(scope_id TEXT NOT NULL,service_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,service_id,command_id)); PRAGMA user_version=10;`,
  11: `CREATE TABLE installation_ownership(singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),record TEXT NOT NULL); PRAGMA user_version=11;`,
  12: 'PRAGMA user_version=12;',
  13: `CREATE TABLE model_activations(scope_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_version INTEGER NOT NULL,
    model_id TEXT NOT NULL,model_version INTEGER NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,provider_id,provider_version,model_id,model_version));
    CREATE TABLE model_activation_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,command_id)); PRAGMA user_version=13;`,
  14: `CREATE TABLE model_invocation_allocations(scope_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
    max_calls INTEGER NOT NULL,max_in_flight INTEGER NOT NULL,lifetime_calls INTEGER NOT NULL,in_flight INTEGER NOT NULL,
    record TEXT NOT NULL,PRIMARY KEY(scope_id,allocation_id));
    CREATE TABLE model_invocations(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,invocation_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('claimed','responded','unknown')),record TEXT NOT NULL,
    PRIMARY KEY(scope_id,invocation_id),UNIQUE(scope_id,command_id));
    CREATE INDEX model_invocations_allocation_state ON model_invocations(scope_id,allocation_id,state);
    PRAGMA user_version=14;`,
  22: `CREATE TABLE provider_spend_audits(sequence INTEGER PRIMARY KEY AUTOINCREMENT,scope_id TEXT NOT NULL,
    budget_id TEXT NOT NULL,budget_revision INTEGER NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,
    UNIQUE(scope_id,command_id));
    CREATE INDEX provider_spend_audits_budget_latest
      ON provider_spend_audits(scope_id,budget_id,budget_revision,sequence DESC);
    PRAGMA user_version=22;`,
});
export function requireLedgerVersion(db: DatabaseSync, minimum: number) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < minimum || version > CURRENT_LEDGER_VERSION) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  return version;
}
/** Caller owns BEGIN IMMEDIATE / rollback. Never migrate from read-only surface composition. `companyId` owns the v39 backfill:
 * the upgrading service passes its configured company; other callers get the config default, the value an unconfigured
 * installation resolves. */
export function migrateLedger(db: DatabaseSync, mode: 'allow' | 'forbid', profiles?: SupervisorProfileValidator,
  companyId: string = getConfigFieldDefault('company').id): void {
  const version = requireLedgerVersion(db, 0);
  if (mode === 'forbid' && version !== CURRENT_LEDGER_VERSION) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  // Older custody validators inspect the current Run shape. Prove and convert old eligibility
  // before those validators, inside the same transaction; never skip their independent checks.
  if (version >= 3 && version < IMMEDIATE_ELIGIBILITY_LEDGER_VERSION) migrateImmediateEligibility(db);
  const codeSteps: Readonly<Record<number, () => void>> = { 5: () => requireLedgerV5Custody(db), 6: () => requireLedgerV6ProfileCompatibility(db, profiles),
    8: () => requireLedgerV8ExecutionRegistry(db), 15: () => migrateModelInvocationEvidence(db), 16: () => migrateModelInvocationContents(db),
    17: () => migrateModelInvocationPurge(db), 18: () => migrateModelInvocationControl(db), 19: () => migrateModelAllocationCheckpoints(db),
    20: () => migrateProviderSpend(db), 21: () => migrateProviderReportedSpend(db), [SCOPE_REGISTRY_LEDGER_VERSION]: () => migrateScopeRegistry(db, companyId),
    [AUDIT_EVENT_LEDGER_VERSION]: () => migrateAuditEvents(db), [ADOPTION_VERIFICATION_LEDGER_VERSION]: () => migrateAdoptionVerification(db),
    [MODEL_CATALOG_LEDGER_VERSION]: () => migrateModelCatalog(db), [POOL_HOLD_LEDGER_VERSION]: () => migrateExecutionPoolHolds(db),
    [RUN_PARKING_LEDGER_VERSION]: () => migrateRunParking(db), [DECISION_PORT_LEDGER_VERSION]: () => migrateDecisionPort(db),
    [POOL_CAPACITY_LEDGER_VERSION]: () => migratePoolCapacity(db), 49: () => migrateMeasuredTariffSpend(db) };
  for (let next = version + 1; next <= CURRENT_LEDGER_VERSION; next++) {
    if (next === 52) { migrateRunCreateApprovals(db); continue; }
    // Code-owned steps: each runs, then the version is recorded, in this one transaction.
    const step = codeSteps[next];
    if (step) { step(); db.exec(`PRAGMA user_version=${next};`); continue; }
    if (next === AUDIT_CHECKPOINT_LEDGER_VERSION) { migrateAuditCheckpoints(db); continue; }
    if (next === 54) { migrateQuotaWaits(db); continue; }
    const sql = migrations[next];
    if (!sql) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
    if (next === RUN_PROPOSAL_LEDGER_VERSION) {
      // A previous version cannot contain proposal objects. Refuse a contradictory
      // schema; never silently adopt an existing table or bypass append-only triggers.
      try { db.exec(sql); } catch { throw new AttemptStoreError('ATTEMPT_STORE_VERSION'); }
    } else db.exec(sql);
  }
}
