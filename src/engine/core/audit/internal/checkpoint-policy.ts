import { z } from 'zod';
import registry from './registry.json' with { type: 'json' };
/** Cadence is a registry setting in event counts; inactivity never creates empty checkpoints. */
export const auditCheckpointPolicySchema = z.object({ schemaVersion: z.literal(1).optional(),
  everyRecords: z.number().int().min(1).max(1000).default(registry.everyRecords),
  maxRecords: z.number().int().min(1000).max(1000000).default(registry.maxRecords),
  pageSize: z.number().int().min(1).max(1000).default(registry.pageSize),
}).strict();
export type AuditCheckpointPolicy = z.infer<typeof auditCheckpointPolicySchema>;
