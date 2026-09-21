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
export const CURRENT_LEDGER_VERSION = 31;
export const INTEGRATION_LEDGER_VERSION = 30;
const migrations: Readonly<Record<number, string>> = Object.freeze({
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
  15: '',
  16: '',
  17: '',
  18: '',
  19: '',
  20: '',
  21: '',
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
/** Caller owns BEGIN IMMEDIATE / rollback. Never migrate from read-only surface composition. */
export function migrateLedger(db: DatabaseSync, mode: 'allow' | 'forbid', profiles?: SupervisorProfileValidator): void {
  const version = requireLedgerVersion(db, 0);
  if (mode === 'forbid' && version !== CURRENT_LEDGER_VERSION) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  // Older custody validators inspect the current Run shape. Prove and convert old eligibility
  // before those validators, inside the same transaction; never skip their independent checks.
  if (version >= 3 && version < IMMEDIATE_ELIGIBILITY_LEDGER_VERSION) migrateImmediateEligibility(db);
  for (let next = version + 1; next <= CURRENT_LEDGER_VERSION; next++) {
    if (next === 5) {
      requireLedgerV5Custody(db);
      db.exec('PRAGMA user_version=5;');
      continue;
    }
    if (next === 6) {
      requireLedgerV6ProfileCompatibility(db, profiles);
      db.exec('PRAGMA user_version=6;');
      continue;
    }
    if (next === 8) {
      requireLedgerV8ExecutionRegistry(db);
      db.exec('PRAGMA user_version=8;');
      continue;
    }
    if (next === 15) {
      migrateModelInvocationEvidence(db);
      db.exec('PRAGMA user_version=15;');
      continue;
    }
    if (next === 16) {
      migrateModelInvocationContents(db);
      db.exec('PRAGMA user_version=16;');
      continue;
    }
    if (next === 17) {
      migrateModelInvocationPurge(db);
      db.exec('PRAGMA user_version=17;');
      continue;
    }
    if (next === 18) {
      migrateModelInvocationControl(db);
      db.exec('PRAGMA user_version=18;');
      continue;
    }
    if (next === 19) {
      migrateModelAllocationCheckpoints(db);
      db.exec('PRAGMA user_version=19;');
      continue;
    }
    if (next === 20) {
      migrateProviderSpend(db);
      db.exec('PRAGMA user_version=20;');
      continue;
    }
    if (next === 21) {
      migrateProviderReportedSpend(db);
      db.exec('PRAGMA user_version=21;');
      continue;
    }
    const sql = migrations[next];
    if (!sql) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
    db.exec(sql);
  }
}
