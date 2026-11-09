import { z } from 'zod';
import { approvalRecordSchema, identitySchema } from '#domain/index.js';

/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). Runtime v20. Memory confirmation is separate from the sealed once decision and from its effect. */
export const sessionStandingResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ scope: z.literal('session'), status: z.literal('saved') }),
  z.strictObject({ scope: z.literal('session'), status: z.literal('not-saved'), reason: z.enum([
    'audit-unavailable', 'revoked', 'expired', 'cancelled', 'stopped', 'secret-bearing', 'policy-changed', 'evicted',
  ]) }),
  z.strictObject({ scope: z.literal('session'), status: z.literal('unconfirmed'), reason: z.enum(['result-unavailable', 'transport-unknown']) }),
]);
export type SessionStandingResult = z.infer<typeof sessionStandingResultSchema>;
export const sessionApprovalResultSchema = z.strictObject({ record: approvalRecordSchema, standing: sessionStandingResultSchema });
export type SessionApprovalResult = z.infer<typeof sessionApprovalResultSchema>;
export function parseApprovalAnswer(session: boolean, value: unknown) {
  return session ? sessionApprovalResultSchema.parse(value) : approvalRecordSchema.parse(value);
}
export const clearSessionStandingSchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, sessionId: identitySchema });
export const sessionStandingClearanceSchema = clearSessionStandingSchema.extend({ cleared: z.literal(true) }).strict();
export type ClearSessionStanding = z.infer<typeof clearSessionStandingSchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type SessionStandingClearance = z.infer<typeof sessionStandingClearanceSchema>;
export function acceptSessionStandingClearance(input: ClearSessionStanding, value: unknown): SessionStandingClearance {
  const result = sessionStandingClearanceSchema.parse(value);
  if (input.scopeId !== result.scopeId || input.sessionId !== result.sessionId) throw new Error('RUNTIME_SERVICE_CORRELATION');
  return result;
}
