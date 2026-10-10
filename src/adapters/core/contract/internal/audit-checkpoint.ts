import { z } from 'zod';
import { auditCheckpointPolicySchema } from '#engine/index.js';
import { CONFIG_CONTRACT_SINCE, ConfigValidationError, registerConfigSection } from '#platform/index.js';
const auditCheckpointConfigSchema = auditCheckpointPolicySchema.extend({ schemaVersion: z.literal(1) });
export function registerAuditCheckpointConfig(): void {
  registerConfigSection('audit_checkpoints', auditCheckpointConfigSchema, {
    optional: true, secretReferences: 'forbid',
    validateLayers(global, project) {
      if (project === undefined) return;
      const parent = auditCheckpointPolicySchema.parse(global ?? {}), child = auditCheckpointPolicySchema.parse(project);
      if (child.everyRecords > parent.everyRecords || child.maxRecords > parent.maxRecords || child.pageSize > parent.pageSize) {
        throw new ConfigValidationError([{ path: 'audit_checkpoints', reason: 'POLICY_AUTHORITY_INVALID' }]);
      }
    },
    metadata: { descriptionKey: 'config.field.audit_checkpoints', tier: 'core', since: CONFIG_CONTRACT_SINCE,
      binding: { state: 'bound', consumers: ['src/composition/core/audit', 'src/composition/core/agent-turn', 'src/composition/core/runtime-service', 'src/composition/core/decision', 'src/composition/core/runs', 'src/composition/core/approvals', 'src/composition/core/model-connect', 'src/composition/core/installation', 'src/adapters/core/config-file'] }, apply: 'restart' },
  });
}
