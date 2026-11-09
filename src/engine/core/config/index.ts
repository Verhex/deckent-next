export { ConfigApplication, assertConfigPersonWitness, configWriteOperation, isProtectedConfigWrite } from './internal/application.js';
export { ConfigApplicationError } from './internal/contract.js';
export type { ConfigFieldView, ConfigSnapshot, ConfigLayer, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ConfigSource, ConfigWriteInput, ConfigWriteResult, ConfigDocumentPort, ConfigAuthorityPort, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ConfigPlan,
  ConfigApprovalPort, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ConfigApprovalAdmission, ConfigAuthorization, ConfigChangeOutcome, ConfigChangeSubject, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ConfigPermissionDecision, ConfigWritePermission } from './internal/contract.js';
export { planConfigChange, validateConfigLayers } from './internal/planner.js';
export { configDefinitions, configPath, atConfigPath, definitionFor, configFieldView, allConfigKeys, parseConfigInput, projectInputSchema } from './internal/registry.js';
export { authorizeConfigWrite, evaluateConfigWrite } from './internal/policy.js';
export { configServiceState } from './internal/service-state.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ConfigServiceState, DescribeService } from './internal/service-state.js';
export { restartConfigDigest, runtimeConfigFreshness } from './internal/restart-digest.js';
export { publishedConfigProgress } from './internal/publication-progress.js';
