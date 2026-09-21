import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';

/** Ephemeral verifier evidence; never extend persisted actor/principal receipts with these fields. */
export const verifiedSessionSchema = z.object({
  schemaVersion: z.literal(1), sessionId: identitySchema, authorityRef: identitySchema,
  kind: z.enum(['os-user', 'token-verified']),
  principalRef: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly(),
  scopeIds: z.array(identitySchema).min(1).readonly(),
  authenticatedAt: counterSchema, expiresAt: counterSchema,
}).strict().refine(s => s.expiresAt > s.authenticatedAt, { message: 'SESSION_TIME_INVALID' }).readonly();
export type VerifiedSession = z.infer<typeof verifiedSessionSchema>;
