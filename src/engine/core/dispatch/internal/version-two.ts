import { z } from 'zod';
import { supervisorProfileSchema } from '#engine/core/supervisor/index.js';
import { dispatchClaimSchema, dispatchRecordSchema } from './port.js';

export const DISPATCH_RECORD_V2_SCHEMA_VERSION = 2;
/** Claim owns immutable custody data; it does not grant physical launch. The ledger serializes
 * launch admission against durable cancellation. Replaying a grant must never launch again.
 */
export const dispatchClaimV2Schema = dispatchClaimSchema.unwrap().extend({ profile: supervisorProfileSchema }).strict().readonly();
export const dispatchRecordV2Schema = dispatchRecordSchema.unwrap().omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(DISPATCH_RECORD_V2_SCHEMA_VERSION),
  profile: supervisorProfileSchema,
  launch: z.enum(['pending', 'granted', 'prevented-before-launch']),
}).strict().superRefine((record, context) => {
  // Prevention is not a synthetic process exit. Unknown effects after a grant remain unresolved.
  if (record.launch !== 'granted' && (record.terminal !== null || record.output !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['launch'], message: 'DISPATCH_LAUNCH_EVIDENCE_CONFLICT' });
  }
}).readonly();
export type DispatchClaimV2 = z.infer<typeof dispatchClaimV2Schema>;
export type DispatchRecordV2 = z.infer<typeof dispatchRecordV2Schema>;
