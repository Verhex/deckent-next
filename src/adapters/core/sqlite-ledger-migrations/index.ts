// Code-owned ledger migration steps (history): split out of sqlite-ledger (S4B-1) so the schema unit keeps its unit budget. `schema.ts` dispatches them.
export { requireLedgerV5Custody } from './internal/migration-v5.js';
export { requireLedgerV6ProfileCompatibility } from './internal/migration-v6.js';
export { requireLedgerV8ExecutionRegistry } from './internal/migration-v8.js';
export { migrateImmediateEligibility } from './internal/migration-v12.js';
export { migrateModelInvocationEvidence } from './internal/migration-v15.js';
export { migrateModelInvocationContents } from './internal/migration-v16.js';
export { migrateModelInvocationPurge } from './internal/migration-v17.js';
export { migrateModelInvocationControl } from './internal/migration-v18.js';
export { migrateModelAllocationCheckpoints } from './internal/migration-v19.js';
export { migrateProviderSpend } from './internal/migration-v20.js';
export { migrateProviderReportedSpend } from './internal/migration-v21.js';
export { migrateScopeRegistry } from './internal/migration-v39.js';
export { migrateAuditEvents } from './internal/migration-v41.js';
export { migrateAdoptionVerification } from './internal/migration-v42.js';
export { migrateModelCatalog } from './internal/migration-v43.js';
export { migrateExecutionPoolHolds } from './internal/migration-v44.js';
export { migrateRunParking } from './internal/migration-v45.js';
export { migrateDecisionPort } from './internal/migration-v46.js';
export { migratePoolCapacity } from './internal/migration-v47.js';
export { migrateMeasuredTariffSpend } from './internal/migration-v49.js';
export { migrateRunCreateApprovals } from './internal/migration-v52.js';
export { migrateQuotaWaits } from './internal/migration-v54.js';
export { migrateAuditCheckpoints } from './internal/migration-v56.js';
export { migrateEffectProducerIndex, revertEffectProducerIndex } from './internal/migration-v63.js';

export { migrateProviderSpendPeriods } from './internal/migration-v72.js';
