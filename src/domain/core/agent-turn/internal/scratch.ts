import { persistedString, persistedInteger, identitySchema } from '#domain/core/primitives/index.js';
import { z } from 'zod';


const count = persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const path = persistedString(z.string().min(1).max(4096));
/** Most files one `/scratch` view names (newest first); the rest is counted in `bytes` and flagged `truncated`. */
export const SCRATCH_VIEW_MAX_FILES = 200;

/**
 * The caller's own scratch area of one conversation (runtime v16 `inspectScratch` / `clearScratch`, SCR-A). No principal field: the
 * socket peer is the owner, so a caller only ever sees or empties their own area of a scope they belong to.
 */
export const scratchQuerySchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, sessionId: identitySchema }).readonly();
export type ScratchQuery = z.infer<typeof scratchQuerySchema>;
export const parseScratchQuery = (value: unknown): ScratchQuery => scratchQuerySchema.parse(value);
export const scratchViewSchema = z.strictObject({ schemaVersion: z.literal(1), path, exists: z.boolean(), bytes: count, truncated: z.boolean(),
  files: z.array(z.strictObject({ path, bytes: count, modifiedAtMs: count })).max(SCRATCH_VIEW_MAX_FILES),
  limits: z.strictObject({ writeMaxBytes: count, sessionMaxBytes: count, retentionDays: count }) }).readonly();
export type ScratchView = z.infer<typeof scratchViewSchema>;
export const scratchClearanceSchema = z.strictObject({ schemaVersion: z.literal(1), path, removedFiles: count, removedBytes: count }).readonly();
export type ScratchClearance = z.infer<typeof scratchClearanceSchema>;
