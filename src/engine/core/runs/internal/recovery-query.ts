import { z } from 'zod';
import { attemptIdentitySchema, counterSchema, identitySchema, type AttemptIdentity } from '#domain/index.js';

export const cancellationRecoveryQuerySchema = z.strictObject({
  scopeId: identitySchema, afterAttemptId: identitySchema.nullable(), limit: counterSchema.positive(), now: counterSchema,
}).readonly();
export const cancellationRecoveryPageSchema = z.strictObject({
  identities: z.array(attemptIdentitySchema).readonly(), nextAfterAttemptId: identitySchema.nullable(),
}).readonly();
export type CancellationRecoveryQuery = z.infer<typeof cancellationRecoveryQuerySchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type CancellationRecoveryPage = z.infer<typeof cancellationRecoveryPageSchema>;
export interface CancellationRecoveryQueryStore {
  /** Discovery grants no authority. Callers authorize scope before scanning and each identity before claiming delivery. */
  discoverCancellationRecovery(input: CancellationRecoveryQuery): Promise<CancellationRecoveryPage>;
}
export function cancellationRecoveryPage(identities: readonly AttemptIdentity[], nextAfterAttemptId: string | null): CancellationRecoveryPage {
  return cancellationRecoveryPageSchema.parse({ identities, nextAfterAttemptId });
}
