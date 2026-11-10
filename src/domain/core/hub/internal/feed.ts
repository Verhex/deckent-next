import { z } from 'zod';
import { HUB_LIMITS } from './registry.js';
import { hubDigestSchema, hubSignatureValueSchema, hubText, hubTimeSchema } from './fields.js';
import { hubKeyDelegationSchema } from './delegation.js';

export const hubFeedSignatureSchema = z.strictObject({ keyId: hubDigestSchema, algorithm: z.literal('ed25519'), value: hubSignatureValueSchema }).readonly();
export const hubRevocationEntrySchema = z.strictObject({ kind: z.enum(['key', 'package-version', 'publisher']), id: hubText(256), severity: z.enum(['yank', 'revoke']),
  reason: hubText(1024), atMs: hubTimeSchema }).readonly();
export const hubRevocationCursorSchema = z.strictObject({ schemaVersion: z.literal(1), hubId: hubDigestSchema,
  afterSequence: hubTimeSchema, throughSequence: hubTimeSchema, position: hubTimeSchema, throughPosition: hubTimeSchema,
  page: hubTimeSchema.positive(), issuedAtMs: hubTimeSchema, nextRefreshBy: hubTimeSchema, signature: hubFeedSignatureSchema
}).refine(row => row.afterSequence <= row.throughSequence && row.position < row.throughPosition && row.nextRefreshBy > row.issuedAtMs).readonly();
export type HubRevocationCursor = z.infer<typeof hubRevocationCursorSchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const hubRevocationCatchupSchema = z.strictObject({ schemaVersion: z.literal(1), afterSequence: hubTimeSchema, throughSequence: hubTimeSchema,
  position: hubTimeSchema, throughPosition: hubTimeSchema, page: hubTimeSchema, complete: z.boolean(), next: hubRevocationCursorSchema.nullable()
}).refine(row => row.afterSequence <= row.throughSequence && row.position <= row.throughPosition && row.complete === (row.next === null)
  && (!row.next || row.next.afterSequence === row.afterSequence && row.next.throughSequence === row.throughSequence
    && row.next.throughPosition === row.throughPosition && row.next.position > row.position && row.next.page === row.page + 1)).readonly();
export const hubRevocationFeedSchema = z.strictObject({ schemaVersion: z.literal(1), hubId: hubDigestSchema, sequence: hubTimeSchema.positive(),
  issuedAtMs: hubTimeSchema, nextRefreshBy: hubTimeSchema,
  entries: z.array(hubRevocationEntrySchema).max(HUB_LIMITS.feedPageMax).readonly(),
  catchup: hubRevocationCatchupSchema.optional(),
  // Present when an online feed key (not the pinned root) signs: the root's delegation of that key, inside the signed payload.
  delegation: hubKeyDelegationSchema.optional(),
  signature: hubFeedSignatureSchema }).refine(row => row.nextRefreshBy > row.issuedAtMs && row.entries.every(e => e.atMs <= row.issuedAtMs)).readonly();
export type HubRevocationFeed = z.infer<typeof hubRevocationFeedSchema>;
