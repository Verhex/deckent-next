import { z } from 'zod';
import { operationDescriptorSchema, type OperationDescriptor } from '#domain/index.js';
import { CONFIG_CONTRACT_SINCE, ConfigValidationError, registerConfigSection } from '#platform/index.js';
import { httpConditionalEffectOptionsSchema } from '#adapters/core/http-conditional-effect/index.js';

/** Operation catalog and effect targets are business policy data. Empty by default: no operation can run until an operator
 * declares it. Registry-provided (Enterprise/ERP) targets arrive through A04; this section wires the Core generic target only. */
const operationsSectionSchema = z.object({
  catalog: z.array(operationDescriptorSchema).max(1024).default([]),
  targets: z.array(z.object({ adapter: z.literal('http-conditional'), options: httpConditionalEffectOptionsSchema }).strict()).max(64).default([]),
}).strict();
export const operationsConfigSchema = operationsSectionSchema.superRefine((value, context) => {
  const operations = new Set<string>(), kinds = new Set<string>();
  for (const target of value.targets) {
    if (kinds.has(target.options.kind)) context.addIssue({ code: 'custom', message: 'OPERATION_TARGET_DUPLICATE' });
    kinds.add(target.options.kind);
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
});
export type OperationsConfig = z.infer<typeof operationsConfigSchema>;
export function readOperationsConfig(config: Record<string, unknown>): OperationsConfig {
  return operationsConfigSchema.parse(config['operations'] ?? {});
}
export function findOperation(config: OperationsConfig, id: string, version: number): OperationDescriptor | null {
  return config.catalog.find(entry => entry.operation.id === id && entry.operation.version === version) ?? null;
}
export function registerOperationsConfig(): void {
  registerConfigSection('operations', operationsSectionSchema, {
    optional: true,
    validateValue: value => {
      if (value !== undefined && !operationsConfigSchema.safeParse(value).success) throw new ConfigValidationError([{ path: 'operations', reason: 'OPERATIONS_INVALID' }]);
    },
    secretReferences: 'forbid',
    metadata: { descriptionKey: 'config.field.operations', tier: 'core', since: CONFIG_CONTRACT_SINCE },
  });
}
