import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parseProviderSpendBudget, providerSpendBudgetSchema } from '#domain/index.js';
import { CONFIG_CONTRACT_SINCE, ConfigValidationError, registerConfigSection } from '#platform/index.js';
import { ProviderSpendError } from '#engine/index.js';

export const providerSpendingSchema = z.object({ schemaVersion: z.literal(1),
  budgets: z.array(providerSpendBudgetSchema).readonly() }).strict();

function invalid(): never {
  throw new ConfigValidationError([{ path: 'provider_spending', reason: 'POLICY_AUTHORITY_INVALID' }]);
}
function validate(input: unknown) {
  const parsed = providerSpendingSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const scopes = new Set<string>();
  for (const raw of parsed.data.budgets) {
    let budget;
    try { budget = parseProviderSpendBudget(raw); } catch { return invalid(); }
    if (scopes.has(budget.scopeId)) invalid();
    scopes.add(budget.scopeId);
  }
  return parsed.data;
}

/** An authored parent owns budget identity and ceilings; a child may select only an exact subset. */
export function validateProviderSpendingLayers(global: unknown, project: unknown): void {
  const parent = global === undefined ? undefined : validate(global);
  if (project === undefined) return;
  const child = validate(project);
  if (!parent) return;
  for (const budget of child.budgets) {
    if (!parent.budgets.some(candidate => isDeepStrictEqual(candidate, budget))) invalid();
  }
}

export function registerProviderSpendingConfig(): void {
  registerConfigSection('provider_spending', providerSpendingSchema, {
    optional: true, secretReferences: 'forbid',
    metadata: { descriptionKey: 'config.field.provider_spending', tier: 'core', since: CONFIG_CONTRACT_SINCE, binding: { state: 'bound', consumers: ['src/adapters/core/contract'] }, apply: 'restart' },
    validateLayers: validateProviderSpendingLayers,
    validateValue: value => { if (value !== undefined) validate(value); },
  });
}

/** The scope's budget in a loaded configuration's `provider_spending`; an absent or unreadable section, or no budget for the scope, is
 * `PROVIDER_SPEND_UNAVAILABLE` (a model call is never priced without one). */
export function providerSpendingBudgetFor(config: Record<string, unknown>, scopeId: string) {
  const value = providerSpendingConfiguredBudget(config, scopeId);
  if (!value) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  return value;
}
/** Stage 1: the scope's configured budget, or null when the section is absent or names no budget for it; an unreadable section still refuses. */
export function providerSpendingConfiguredBudget(config: Record<string, unknown>, scopeId: string) {
  if (config['provider_spending'] === undefined) return null;
  const parsed = providerSpendingSchema.safeParse(config['provider_spending']);
  if (!parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  return parsed.data.budgets.find(candidate => candidate.scopeId === scopeId) ?? null;
}
