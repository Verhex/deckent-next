import { z } from 'zod';
import limits from './limits.json' with { type: 'json' };

export const AUDIT_REFUSAL_TOKEN_MAX_CHARS = limits.refusalTokenMaxChars;
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const refusalToken = z.string().min(1).max(AUDIT_REFUSAL_TOKEN_MAX_CHARS).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u);
/** Scope-keyed identity only; this reader has no resolution port. */
export const opaqueIdentitySchema = z.strictObject({ keyId: refusalToken, digest });
export type OpaqueIdentity = z.infer<typeof opaqueIdentitySchema>;
