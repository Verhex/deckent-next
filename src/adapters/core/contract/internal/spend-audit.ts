import { z } from 'zod';
import { providerSpendAuditWorkLimitsSchema } from '#engine/index.js';
import { CONFIG_CONTRACT_SINCE, ConfigValidationError, registerConfigSection } from '#platform/index.js';

/** Work bounds are explicit configuration, not permission to inspect or mutate an account. */
export const providerSpendAuditConfigSchema = providerSpendAuditWorkLimitsSchema.extend({ schemaVersion: z.literal(1) }).strict();

export function validateProviderSpendAuditLayers(global: unknown, project: unknown): void {
  const parent = global === undefined ? undefined : providerSpendAuditConfigSchema.parse(global);
  if (project === undefined) return;
  const child = providerSpendAuditConfigSchema.parse(project);
  if (parent && (child.pageSize > parent.pageSize || child.maxReservations > parent.maxReservations
    || child.timeoutMs > parent.timeoutMs)) {
    throw new ConfigValidationError([{ path: 'provider_spend_audit', reason: 'POLICY_AUTHORITY_INVALID' }]);
  }
}

export function registerProviderSpendAuditConfig(): void {
  registerConfigSection('provider_spend_audit', providerSpendAuditConfigSchema, {
    optional: true, secretReferences: 'forbid', validateLayers: validateProviderSpendAuditLayers,
    metadata: { descriptionKey: 'config.field.provider_spend_audit', tier: 'core', since: CONFIG_CONTRACT_SINCE },
  });
}
