import { z } from 'zod';
import { approvalRecordSchema, identitySchema } from '#domain/index.js';

/** Runtime v20. Memory confirmation is separate from the sealed once decision and from its effect. */
export const sessionStandingResultSchema = z.discriminatedUnion('status', [
  z.object({ scope: z.literal('session'), status: z.literal('saved') }).strict(),
  z.object({ scope: z.literal('session'), status: z.literal('not-saved'), reason: z.enum([
    'audit-unavailable', 'revoked', 'expired', 'cancelled', 'stopped', 'secret-bearing', 'policy-changed', 'evicted',
  ]) }).strict(),
  z.object({ scope: z.literal('session'), status: z.literal('unconfirmed'), reason: z.enum(['result-unavailable', 'transport-unknown']) }).strict(),
]);
export type SessionStandingResult = z.infer<typeof sessionStandingResultSchema>;
export const sessionApprovalResultSchema = z.object({ record: approvalRecordSchema, standing: sessionStandingResultSchema }).strict();
export type SessionApprovalResult = z.infer<typeof sessionApprovalResultSchema>;
export function parseApprovalAnswer(session: boolean, value: unknown) {
  return session ? sessionApprovalResultSchema.parse(value) : approvalRecordSchema.parse(value);
}
export const clearSessionStandingSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, sessionId: identitySchema }).strict();
export const sessionStandingClearanceSchema = clearSessionStandingSchema.extend({ cleared: z.literal(true) }).strict();
export type ClearSessionStanding = z.infer<typeof clearSessionStandingSchema>;
export type SessionStandingClearance = z.infer<typeof sessionStandingClearanceSchema>;
export function acceptSessionStandingClearance(input: ClearSessionStanding, value: unknown): SessionStandingClearance {
  const result = sessionStandingClearanceSchema.parse(value);
  if (input.scopeId !== result.scopeId || input.sessionId !== result.sessionId) throw new Error('RUNTIME_SERVICE_CORRELATION');
  return result;
}
