import { z } from 'zod';
import { identitySchema, operationDescriptorSchema, OperationCatalogError, RegistryError } from '#domain/index.js';
import type { EffectTargets, UnifiedOperationCatalog } from '#engine/index.js';
import { CONFIG_CONTRACT_SINCE, ConfigValidationError, registerConfigSection } from '#platform/index.js';
import { operationAdapters as registry } from '#adapters/core/extension-registry/index.js';

/** Operation catalog and effect targets are business policy data. Empty by default: no operation can run until an operator
 * declares it. `targets[].adapter` names a registry entry (Core `http-conditional` or a registered module adapter), never a literal. */
const operationsSectionSchema = z.strictObject({
  catalog: z.array(operationDescriptorSchema).max(1024).prefault([]),
  targets: z.array(z.strictObject({ adapter: identitySchema, options: z.unknown().optional() })).max(64).prefault([]),
});
export const operationsConfigSchema = operationsSectionSchema.superRefine((value, context) => {
  const operations = new Set<string>(), kinds = new Set<string>();
  for (const target of value.targets) {
    // Options go through the adapter's registered Standard Schema in the registry (one validation owner); a Promise-returning
    // schema cannot be honoured by this synchronous validation and gets its own typed issue.
    const options = registry.targetOptions(target.adapter, target.options);
    if (options.status === 'unknown') { context.addIssue({ code: 'custom', message: 'OPERATION_ADAPTER_UNKNOWN' }); continue; }
    if (options.status === 'async') { context.addIssue({ code: 'custom', message: 'OPERATION_TARGET_OPTIONS_ASYNC' }); continue; }
    if (options.status === 'invalid') { context.addIssue({ code: 'custom', message: 'OPERATION_TARGET_OPTIONS_INVALID' }); continue; }
    if (kinds.has(options.value.kind)) context.addIssue({ code: 'custom', message: 'OPERATION_TARGET_DUPLICATE' });
    kinds.add(options.value.kind);
  }
  for (const entry of value.catalog) {
    const key = `${entry.operation.id}@${entry.operation.version}`;
    if (operations.has(key)) context.addIssue({ code: 'custom', message: 'OPERATION_DUPLICATE' });
    operations.add(key);
    if (!kinds.has(entry.targetKind)) context.addIssue({ code: 'custom', message: 'OPERATION_TARGET_UNKNOWN' });
  }
  for (const entry of value.catalog) if (entry.compensation && !operations.has(`${entry.compensation.id}@${entry.compensation.version}`)) {
    context.addIssue({ code: 'custom', message: 'OPERATION_COMPENSATION_UNKNOWN' });
  }
  // The unified catalog (Core code + registered modules + this config) must be conflict-free before the config means anything (A04-2).
  try { registry.catalog(value.catalog, [...kinds]); }
  catch (error) { if (!(error instanceof OperationCatalogError)) throw error; context.addIssue({ code: 'custom', message: error.code }); }
});
export type OperationsConfig = z.infer<typeof operationsConfigSchema>;
export function readOperationsConfig(config: Record<string, unknown>): OperationsConfig {
  return operationsConfigSchema.parse(config['operations'] ?? {});
}
/** The one operation resolver of every producer (CLI, SDK, ...): Core code operations, registered module operations and the validated
 * config catalog, unified through the registry. Validation already refused conflicts, so this cannot fail on a loaded configuration. */
export function resolveOperationCatalog(config: OperationsConfig): UnifiedOperationCatalog {
  return registry.catalog(config.catalog, config.targets.map(target => {
    const options = registry.targetOptions(target.adapter, target.options);
    if (options.status !== 'valid') throw new RegistryError(options.status === 'async' ? 'REGISTRY_OPTIONS_ASYNC' : options.status === 'unknown' ? 'REGISTRY_ADAPTER_UNKNOWN' : 'REGISTRY_OPTIONS_INVALID');
    return options.value.kind;
  }));
}
export function resolveOperationTargets(config: OperationsConfig): EffectTargets { return registry.targets(config.targets); }
export function registerOperationsConfig(): void {
  registerConfigSection('operations', operationsSectionSchema, {
    optional: true,
    validateValue: value => {
      if (value !== undefined && !operationsConfigSchema.safeParse(value).success) throw new ConfigValidationError([{ path: 'operations', reason: 'OPERATIONS_INVALID' }]);
    },
    secretReferences: 'forbid',
    metadata: { descriptionKey: 'config.field.operations', tier: 'core', since: CONFIG_CONTRACT_SINCE, binding: { state: 'bound', consumers: ['src/adapters/core/contract'] }, apply: 'restart' },
  });
}
