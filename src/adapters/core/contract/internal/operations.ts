import { z } from 'zod';
import { identitySchema, operationDescriptorSchema, OperationCatalogError } from '#domain/index.js';
import { AdapterRegistry, type AdapterModuleRegistration, type EffectTargets, type UnifiedOperationCatalog } from '#engine/index.js';
import { CONFIG_CONTRACT_SINCE, ConfigValidationError, registerConfigSection } from '#platform/index.js';
import { httpConditionalAdapterModule } from '#adapters/core/http-conditional-effect/index.js';
import { coreHostShellModule, coreScratchWriteModule, coreWorkspaceWriteModule } from './core-operations.js';

/** Process-wide target adapter registry (same lifetime as the config-section registry it feeds). Core entries are passed at
 * construction (the generic HTTP adapter and the Core code operations of the workspace-file and host-shell targets); overlays register
 * through `registerOperationAdapterModule` until `registerOperationsConfig` seals it, so a configuration validated against the registry
 * never changes meaning afterwards. */
const registry = AdapterRegistry.create([httpConditionalAdapterModule, coreWorkspaceWriteModule, coreHostShellModule, coreScratchWriteModule]);
export function registerOperationAdapterModule(registration: AdapterModuleRegistration): void { registry.register(registration); }
/** Operation catalog and effect targets are business policy data. Empty by default: no operation can run until an operator
 * declares it. `targets[].adapter` names a registry entry (Core `http-conditional` or a registered module adapter), never a literal. */
const operationsSectionSchema = z.object({
  catalog: z.array(operationDescriptorSchema).max(1024).default([]),
  targets: z.array(z.object({ adapter: identitySchema, options: z.unknown() }).strict()).max(64).default([]),
}).strict();
export const operationsConfigSchema = operationsSectionSchema.superRefine((value, context) => {
  const operations = new Set<string>(), kinds = new Set<string>();
  for (const target of value.targets) {
    const adapter = registry.adapter(target.adapter);
    if (!adapter) { context.addIssue({ code: 'custom', message: 'OPERATION_ADAPTER_UNKNOWN' }); continue; }
    const options = adapter.factory.optionsSchema.safeParse(target.options);
    if (!options.success) { context.addIssue({ code: 'custom', message: 'OPERATION_TARGET_OPTIONS_INVALID' }); continue; }
    if (kinds.has(options.data.kind)) context.addIssue({ code: 'custom', message: 'OPERATION_TARGET_DUPLICATE' });
    kinds.add(options.data.kind);
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
  return registry.catalog(config.catalog, config.targets.map(target => registry.adapter(target.adapter)!.factory.optionsSchema.parse(target.options).kind));
}
/** Builds the installation's effect targets from validated configuration through the registry. */
export function resolveOperationTargets(config: OperationsConfig): EffectTargets { return registry.targets(config.targets); }
export function registerOperationsConfig(): void {
  registry.seal();
  registerConfigSection('operations', operationsSectionSchema, {
    optional: true,
    validateValue: value => {
      if (value !== undefined && !operationsConfigSchema.safeParse(value).success) throw new ConfigValidationError([{ path: 'operations', reason: 'OPERATIONS_INVALID' }]);
    },
    secretReferences: 'forbid',
    metadata: { descriptionKey: 'config.field.operations', tier: 'core', since: CONFIG_CONTRACT_SINCE },
  });
}
