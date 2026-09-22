import { inferenceServingConfigSchema, parseInferenceServingConfig } from '#domain/index.js';
import { ConfigValidationError, registerConfigSection, CONFIG_CONTRACT_SINCE } from '#platform/index.js';

function validate(input: unknown) {
  try {
    return parseInferenceServingConfig(input);
  } catch {
    throw new ConfigValidationError([{ path: 'inference_serving', reason: 'INFERENCE_SERVING_INVALID' }]);
  }
}

export function registerInferenceServingConfig(): void {
  registerConfigSection('inference_serving', inferenceServingConfigSchema, {
    optional: true,
    secretReferences: 'forbid',
    metadata: { descriptionKey: 'config.field.inference_serving', tier: 'core', since: CONFIG_CONTRACT_SINCE },
    validateValue: value => { if (value !== undefined) validate(value); },
  });
}
