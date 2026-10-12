import { brainPlannerConfigSchema } from '#capabilities/index.js';
import { CONFIG_CONTRACT_SINCE, registerConfigSection } from '#platform/index.js';
export function registerBrainPlannerConfig(): void {
  registerConfigSection('brain_planner', brainPlannerConfigSchema, { secretReferences: 'forbid', metadata: {
    descriptionKey: 'config.field.brain_planner', tier: 'core', since: CONFIG_CONTRACT_SINCE,
    binding: { state: 'bound', consumers: ['src/composition/core/run-planner'] }, apply: 'live',
  } });
}
