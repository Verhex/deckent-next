export { openSqliteLedger, openSqliteLedgerReadOnly, openSqliteLedgerAnchor } from './internal/connection.js';
export { openLedgerSurfaceTail, type LedgerSurfaceKind, type LedgerSurfaceRow, type LedgerSurfaceTail } from './internal/surface-tail.js';
export { ENVIRONMENT_READINESS_LEDGER_VERSION, METRICS_V2_LEDGER_VERSION, POOL_CAPACITY_LEDGER_VERSION, DECISION_PORT_LEDGER_VERSION, RUN_PARKING_LEDGER_VERSION, ADOPTION_VERIFICATION_LEDGER_VERSION, ADOPTION_REPOSITORY_LEDGER_VERSION, MODEL_CATALOG_LEDGER_VERSION, POOL_HOLD_LEDGER_VERSION, AUDIT_EVENT_LEDGER_VERSION, CURRENT_LEDGER_VERSION, RUN_PROPOSAL_LEDGER_VERSION, INTEGRATION_LEDGER_VERSION, DISPATCH_LEDGER_VERSION, INSTALLATION_OWNERSHIP_LEDGER_VERSION,
  migrateLedger, MODEL_ACTIVATION_LEDGER_VERSION, OPERATION_APPROVAL_LEDGER_VERSION, CONFIG_CHANGE_APPROVAL_LEDGER_VERSION, MODEL_ALLOCATION_LEDGER_VERSION, MODEL_INVOCATION_LEDGER_VERSION, PROVIDER_SPEND_LEDGER_VERSION,
  PROVIDER_SPEND_AUDIT_LEDGER_VERSION, requireLedgerVersion, RUN_LEDGER_VERSION, SCOPE_REGISTRY_LEDGER_VERSION, SERVICE_SHUTDOWN_LEDGER_VERSION, WORKER_EVENT_LOG_LEDGER_VERSION } from './internal/schema.js';
export { readScopeCompanies, registerLedgerScopes, type ScopeRegistration } from './internal/scope-registry.js';
export { sqliteFailure, ledgerTransaction, sqliteLedgerOptionsSchema, sqliteEngineMeetsFloor, assertSqliteEngineSupported, SQLITE_ENGINE_FLOOR } from './internal/options.js';
export type { SqliteLedgerOptions } from './internal/options.js';
export { upgradeExistingLedger, type LedgerUpgrade } from './internal/upgrade.js';

export { recordAcceptanceMetric, readRunAcceptanceEvaluations, readAcceptanceEvaluationRows, readAcceptedOperationSettlements } from './internal/acceptance-metrics.js';
export { readRunAcceptanceMetrics } from './internal/acceptance-metrics.js';

export { quotaHeldTasks, readQuotaHolds, persistQuotaAttempt } from './internal/quota.js';

export { MODEL_INVOCATION_PLAN_USAGE_LEDGER_VERSION, AUDIT_CHECKPOINT_LEDGER_VERSION } from './internal/schema.js';
export { readEnvironmentProbeHolds, commitEnvironmentProbeSettlement, writeEnvironmentProbeCustody, releaseEnvironmentProbeCustody, type EnvironmentProbeHold } from './internal/environment-probes.js';
