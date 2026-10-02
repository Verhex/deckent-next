import { decisionPolicySchema, parseDecisionPolicy, type DecisionPolicy } from '#domain/index.js';
import { ConfigValidationError, registerConfigSection, CONFIG_CONTRACT_SINCE } from '#platform/index.js';

function invalid(): never { throw new ConfigValidationError([{ path: 'decision', reason: 'DECISION_POLICY_INVALID' }]); }
function validate(input: unknown): DecisionPolicy {
  try { return parseDecisionPolicy(input); } catch { return invalid(); }
}
/** Company/installation policy may only be narrowed by a child project snapshot. */
export function validateDecisionPolicyLayers(global: unknown, project: unknown): void {
  const parent = global === undefined ? null : validate(global);
  if (project === undefined) return;
  const child = validate(project);
  if (!parent) return;
  if (child.thresholds.choice < parent.thresholds.choice || child.thresholds.sufficiency < parent.thresholds.sufficiency
    || (Object.keys(parent.limits) as (keyof DecisionPolicy['limits'])[]).some(key => child.limits[key] > parent.limits[key])) invalid();
}
export function registerDecisionConfig(): void {
  registerConfigSection('decision', decisionPolicySchema.unwrap(), { optional: true, secretReferences: 'forbid',
    // Read per decision call (composition loads config each request), so a change applies to the next call.
    metadata: { descriptionKey: 'config.field.decision', tier: 'core', since: CONFIG_CONTRACT_SINCE, binding: { state: 'bound', consumers: ['src/adapters/core/contract'] }, apply: 'live' },
    validateLayers: validateDecisionPolicyLayers,
    validateValue: value => { if (value !== undefined) validate(value); },
  });
}
/** Missing policy is unavailable; no universal decision threshold is synthesized. */
export function readDecisionPolicy(config: Record<string, unknown>): DecisionPolicy | null {
  return config['decision'] === undefined ? null : validate(config['decision']);
}
