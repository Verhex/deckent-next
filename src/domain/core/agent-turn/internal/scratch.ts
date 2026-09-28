import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';

const count = z.number().int().nonnegative().safe();
const path = z.string().min(1).max(4096);
/** Most files one `/scratch` view names (newest first); the rest is counted in `bytes` and flagged `truncated`. */
export const SCRATCH_VIEW_MAX_FILES = 200;

/**
 * The caller's own scratch area of one conversation (runtime v16 `inspectScratch` / `clearScratch`, SCR-A). No principal field: the
 * socket peer is the owner, so a caller only ever sees or empties their own area of a scope they belong to.
 */
export const scratchQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, sessionId: identitySchema }).strict().readonly();
export type ScratchQuery = z.infer<typeof scratchQuerySchema>;
export const parseScratchQuery = (value: unknown): ScratchQuery => scratchQuerySchema.parse(value);
export const scratchViewSchema = z.object({ schemaVersion: z.literal(1), path, exists: z.boolean(), bytes: count, truncated: z.boolean(),
  files: z.array(z.object({ path, bytes: count, modifiedAtMs: count }).strict()).max(SCRATCH_VIEW_MAX_FILES),
  limits: z.object({ writeMaxBytes: count, sessionMaxBytes: count, retentionDays: count }).strict() }).strict().readonly();
export type ScratchView = z.infer<typeof scratchViewSchema>;
export const scratchClearanceSchema = z.object({ schemaVersion: z.literal(1), path, removedFiles: count, removedBytes: count }).strict().readonly();
export type ScratchClearance = z.infer<typeof scratchClearanceSchema>;
