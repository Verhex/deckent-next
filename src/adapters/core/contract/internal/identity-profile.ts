import { identityProfileConfigSchema } from '#domain/index.js';
import { IdentityProfileRegistry } from '#engine/index.js';
import { ConfigValidationError, registerConfigSection, CONFIG_CONTRACT_SINCE } from '#platform/index.js';
/** Installation selection is template data, never an active profile or authority change. */
export function readIdentityProfileConfig(input: unknown) {
  if (input === undefined) return null;
  return identityProfileConfigSchema.parse(input);
}
export function registerIdentityProfileConfig() {
  registerConfigSection('identity', identityProfileConfigSchema, { optional: true, secretReferences: 'forbid',
    metadata: { descriptionKey: 'identity.config', tier: 'core', since: CONFIG_CONTRACT_SINCE, apply: 'live',
      binding: { state: 'bound', consumers: ['src/composition/core/identity-profile'] } },
    validateValue(value) { const parsed = identityProfileConfigSchema.parse(value); new IdentityProfileRegistry(parsed.packages).resolve(parsed.profile); },
    validateLayers(_global, project) {
      if (project !== undefined) throw new ConfigValidationError([{ path: 'identity', reason: 'CONFIG_LAYER_INVALID' }]);
    },
  });
}
