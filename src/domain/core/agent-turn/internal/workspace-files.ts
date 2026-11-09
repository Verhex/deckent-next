import { counterSchema, persistedString, persistedInteger, identitySchema } from '#domain/core/primitives/index.js';
import { z } from 'zod';

/**
 * Workspace file mentions of the terminal composer (T-L5 `@file`, runtime protocol v15). The service lists candidate files and
 * returns one file's content through its scoped read boundary (workspace root, Core deny floor, no-follow opens); a surface never
 * reads files itself. The attached text becomes part of the user's message: untrusted context that grants no authority.
 */
export const WORKSPACE_FILE_QUERY_MAX_CHARS = 256;
export const WORKSPACE_FILE_FIND_MAX_RESULTS = 50;
/** Largest content one attachment carries; a larger file is attached as a labelled UTF-8 prefix. */
export const WORKSPACE_ATTACHMENT_MAX_BYTES = 32_768;
const PATH_MAX_CHARS = 4_096;

export const workspaceFileQuerySchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema,
  query: persistedString(z.string().max(WORKSPACE_FILE_QUERY_MAX_CHARS)), limit: persistedInteger().min(1).max(WORKSPACE_FILE_FIND_MAX_RESULTS) }).readonly();
export type WorkspaceFileQuery = z.infer<typeof workspaceFileQuerySchema>;
export const parseWorkspaceFileQuery = (value: unknown): WorkspaceFileQuery => workspaceFileQuerySchema.parse(value);
/** `truncated`: the index stopped at its bound; `incomplete`: some directories could not be listed (never reported as absent). */
export const workspaceFileMatchesSchema = z.strictObject({ schemaVersion: z.literal(1),
  paths: z.array(persistedString(z.string().min(1).max(PATH_MAX_CHARS))).max(WORKSPACE_FILE_FIND_MAX_RESULTS), truncated: z.boolean(), incomplete: z.boolean() }).readonly();
export type WorkspaceFileMatches = z.infer<typeof workspaceFileMatchesSchema>;

export const workspaceAttachmentRequestSchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema,
  path: persistedString(z.string().min(1).max(PATH_MAX_CHARS)), maxBytes: persistedInteger().min(1).max(WORKSPACE_ATTACHMENT_MAX_BYTES) }).readonly();
export type WorkspaceAttachmentRequest = z.infer<typeof workspaceAttachmentRequestSchema>;
export const parseWorkspaceAttachmentRequest = (value: unknown): WorkspaceAttachmentRequest => workspaceAttachmentRequestSchema.parse(value);
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const WORKSPACE_ATTACHMENT_REFUSALS = Object.freeze(['path-invalid', 'path-outside-workspace', 'path-denied', 'not-found', 'path-changed',
  'not-a-file', 'not-a-directory', 'hardlink-refused', 'platform-unsupported', 'binary', 'read-error', 'cancelled'] as const);
/** A refusal is a typed result, not a failure: the turn goes on without that file and the surface says why. */
export const workspaceAttachmentSchema = z.discriminatedUnion('status', [
  z.strictObject({ schemaVersion: z.literal(1), path: persistedString(z.string().min(1).max(PATH_MAX_CHARS)), status: z.literal('attached'), content: z.string(),
    bytes: persistedInteger().nonnegative().max(WORKSPACE_ATTACHMENT_MAX_BYTES), totalBytes: counterSchema, truncated: z.boolean() }),
  z.strictObject({ schemaVersion: z.literal(1), path: persistedString(z.string().min(1).max(PATH_MAX_CHARS)), status: z.literal('refused'), reason: z.enum(WORKSPACE_ATTACHMENT_REFUSALS) }),
]).readonly();
export type WorkspaceAttachment = z.infer<typeof workspaceAttachmentSchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type WorkspaceAttachmentRefusal = typeof WORKSPACE_ATTACHMENT_REFUSALS[number];
