import { brainPlannerConfigSchema } from '#capabilities/index.js';
import { CORE_MODEL_ROLES, ModelRoleError, mergeModelRoleRegistries, modelRoleConfigSchema } from '#domain/index.js';
import { CONFIG_CONTRACT_SINCE, ConfigValidationError, registerConfigSection } from '#platform/index.js';
export function registerBrainPlannerConfig(): void {
  registerConfigSection('brain_planner', brainPlannerConfigSchema, { secretReferences: 'forbid', metadata: {
    descriptionKey: 'config.field.brain_planner', tier: 'core', since: CONFIG_CONTRACT_SINCE,
    binding: { state: 'bound', consumers: ['src/composition/core/run-planner'] }, apply: 'live',
  } });
  // S2 (owner A2): tier/role overlays are installation policy. A project layer never widens which model may serve a role, and an overlay that
  // changes a Core row without compare-and-set is refused when the configuration loads, not first at the Brain gate.
  registerConfigSection('model_roles', modelRoleConfigSchema, { optional: true, secretReferences: 'forbid', metadata: {
    descriptionKey: 'assignment.config.modelRoles', tier: 'core', since: CONFIG_CONTRACT_SINCE,
    binding: { state: 'bound', consumers: ['src/composition/core/run-planner'] }, apply: 'live',
  },
  validateValue(value) {
    try { mergeModelRoleRegistries(CORE_MODEL_ROLES, modelRoleConfigSchema.parse(value).overlays); }
    catch (error) { if (error instanceof ModelRoleError) throw new ConfigValidationError([{ path: 'model_roles', reason: error.code }]); throw error; }
  },
  validateLayers(_global, project) {
    if (project !== undefined) throw new ConfigValidationError([{ path: 'model_roles', reason: 'MODEL_ROLE_LAYER_INVALID' }]);
  } });
}
