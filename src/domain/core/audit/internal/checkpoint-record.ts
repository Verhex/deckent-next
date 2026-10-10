import { z } from 'zod';
import { auditEventSchema, auditRecordSchema } from './contract.js';
import { auditCheckpointSubjectSchema } from './checkpoint.js';
/** The independently exportable typed record has the same outer seal as other audit records. */
export const auditCheckpointRecordSchema = auditRecordSchema.unwrap().extend({
  event: auditEventSchema.unwrap().extend({ subject: auditCheckpointSubjectSchema }).strict().readonly(),
}).strict().readonly();
export type AuditCheckpointRecord = z.infer<typeof auditCheckpointRecordSchema>;
