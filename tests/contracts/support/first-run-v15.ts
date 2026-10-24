import { FIRST_RUN_UPGRADE_RULE_IDS } from '#domain/index.js';

/** The first-run template v15 delta (S4B-1 + S7 + S4B-3 + S4B-4 + S6R-5 + S8, owner 2026-10-23), in plan order: since v16 (alpha.56 D1) an earlier
 * version's rules, which the rollback keeps; older-version fixtures leave them out together with the current delta. */
export const FIRST_RUN_V15_RULE_IDS: readonly string[] = Object.freeze((['memoryPropose', 'distillerMemory', 'distillerRuns', 'distillerOutput', 'agentCatalog', 'observeAgentCatalog', 'memoryReview', 'evaluatorMemory', 'evaluatorRuns', 'evaluatorModel', 'memoryPurge', 'recoveryModel', 'signers', 'catalogImport', 'aggregatorCatalog', 'aggregatorRuns', 'aggregatorMemory'] as const).map(key => FIRST_RUN_UPGRADE_RULE_IDS[key]));
