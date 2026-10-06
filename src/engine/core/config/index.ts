export { ConfigApplication } from './internal/application.js';
export { ConfigApplicationError } from './internal/contract.js';
export type { ConfigFieldView, ConfigSnapshot, ConfigLayer, ConfigSource, ConfigWriteInput, ConfigWriteResult, ConfigDocumentPort, ConfigAuthorityPort, ConfigPlan } from './internal/contract.js';
export { planConfigChange, validateConfigLayers } from './internal/planner.js';
export { configDefinitions, configPath, atConfigPath, definitionFor, configFieldView, allConfigKeys } from './internal/registry.js';
export { authorizeConfigWrite } from './internal/policy.js';
export { configServiceState } from './internal/service-state.js';
export type { ConfigServiceState, DescribeService } from './internal/service-state.js';
export { restartConfigDigest, runtimeConfigFreshness } from './internal/restart-digest.js';
