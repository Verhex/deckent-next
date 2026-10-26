import { z } from 'zod';
import { HUB_LIMITS } from './registry.js';
import { hubDigestSchema, hubSignatureValueSchema, hubText, hubTimeSchema } from './fields.js';

export const hubFeedSignatureSchema = z.object({ keyId: hubDigestSchema, algorithm: z.literal('ed25519'), value: hubSignatureValueSchema }).strict().readonly();
export const hubRevocationEntrySchema = z.object({ kind: z.enum(['key', 'package-version', 'publisher']), id: hubText(256), severity: z.enum(['yank', 'revoke']),
  reason: hubText(1024), atMs: hubTimeSchema }).strict().readonly();
export const hubRevocationFeedSchema = z.object({ schemaVersion: z.literal(1), hubId: hubDigestSchema, sequence: hubTimeSchema.positive(),
  issuedAtMs: hubTimeSchema, nextRefreshBy: hubTimeSchema,
  entries: z.array(hubRevocationEntrySchema).max(HUB_LIMITS.feedPageMax).readonly(),
  signature: hubFeedSignatureSchema }).strict().refine(row => row.nextRefreshBy > row.issuedAtMs && row.entries.every(e => e.atMs <= row.issuedAtMs)).readonly();
export type HubRevocationFeed = z.infer<typeof hubRevocationFeedSchema>;
