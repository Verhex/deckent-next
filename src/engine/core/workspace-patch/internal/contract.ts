import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CodedError, persistedString, attemptIdentitySchema } from '#domain/index.js';
import { workspaceSourceSchema } from '#engine/core/workspaces/index.js';
import rules from './rules.json' with { type: 'json' };
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). Bounded reason for PATCH_LIMIT: which configured budget or Git output bound was exceeded. Never carries paths or content. */
export type WorkspacePatchLimitDetail = 'git-output' | 'git-timeout' | 'git-copy' | 'time' | 'bytes' | 'entries' | 'depth' | 'path';
/** Config field an operator changes to raise each PATCH_LIMIT bound (shown in the error text; never a hidden default). */
export const patchLimitFields: Readonly<Record<WorkspacePatchLimitDetail, string>> = Object.freeze({
  bytes: 'artifacts.maxBytes', entries: 'artifacts.patchPreview.maxEntries', depth: 'artifacts.patchPreview.maxDepth', path: 'artifacts.patchPreview.maxPathBytes',
  time: 'execution.git.timeoutMs', 'git-timeout': 'execution.git.timeoutMs', 'git-output': 'execution.git.outputBytes', 'git-copy': 'execution.git.copyBytes' });
export class WorkspacePatchError extends CodedError {
  constructor(override readonly code: 'PATCH_INTEGRATION_PENDING' | 'PATCH_UNAVAILABLE' | 'PATCH_UNSAFE' | 'PATCH_LIMIT' | 'PATCH_UNSUPPORTED' | 'PATCH_CONFLICT' | 'PATCH_CORRUPT'
    | 'PATCH_BASE_ADVANCED' | 'PATCH_SCOPE_VIOLATION' | 'PATCH_SCOPE_UNDECLARED' | 'PATCH_INSTRUCTION_SURFACE_WRITE' | 'PATCH_WORKING_TREE_BUSY' | 'PATCH_WORKING_TREE_PARTIAL' | 'PATCH_WORKING_TREE_KEPT' | 'PATCH_WORKING_TREE_RECORD_UNSUPPORTED' | 'PATCH_WORKING_TREE_UNSUPPORTED' | 'PATCH_WORKING_TREE_SUBFOLDER' | 'PATCH_WORKING_TREE_FILTER' | 'PATCH_WORKING_TREE_FILTERED' | 'PATCH_WORKING_TREE_GIT_VERSION' | 'PATCH_WORKING_TREE_LISTING_LIMIT' | 'PATCH_WORKING_TREE_COPY_LIMIT' | 'PATCH_WORKING_TREE_NOT_WRITTEN' | 'PATCH_WORKING_TREE_CHANGED',
    readonly detail?: WorkspacePatchLimitDetail,
    /** Bounded, repository-relative facts for the error text (K6 scope refusal: count, shown paths, omitted); never host paths or content. */
    override readonly params?: Readonly<Record<string, string | number>>) {
    super(code); this.name = 'WorkspacePatchError';
  }
}
export const patchDigest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const patchExclusions = Object.freeze(rules);
export function isPatchExcluded(path: string) {
  return path.split('/').some(part => rules.excludedSegments.includes(part) || rules.excludedPrefixes.some(prefix => part.startsWith(prefix)));
}
/** A well-formed repository-relative path (no traversal, separators or control characters). History written by others is read with this:
 * it may name paths a patch may never write (e.g. tracked `.deckent/docs`), which are only "touched". */
export const historyPathSchema = persistedString(z.string().min(1)).refine(path => !path.includes('\\') && [...path].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
/** A path the patch itself may write: well formed AND outside every exclusion. */
export const patchPathSchema = historyPathSchema.refine(path => !isPatchExcluded(path));
const fileSchema = z.strictObject({ mode: z.enum(['100644', '100755']), text: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).readonly();
export type PatchFile = z.infer<typeof fileSchema>;
export function patchFile(bytes: Uint8Array, mode: PatchFile['mode']): PatchFile {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new WorkspacePatchError('PATCH_UNSUPPORTED'); }
  if (text.includes('\0')) throw new WorkspacePatchError('PATCH_UNSUPPORTED');
  return Object.freeze({ mode, text, digest: patchDigest(bytes) });
}
export const workspacePatchSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('workspace-patch'),
  identity: attemptIdentitySchema, source: workspaceSourceSchema, baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  exclusions: z.strictObject({ excludedSegments: z.array(z.string()), excludedPrefixes: z.array(z.string()) }),
  changes: z.array(z.strictObject({ path: patchPathSchema, before: fileSchema.nullable(), after: fileSchema.nullable() }).readonly()),
}).superRefine((patch, context) => {
  let previous = '';
  const invalid = () => context.addIssue({ code: 'custom', message: 'PATCH_CORRUPT' });
  if (JSON.stringify(patch.exclusions) !== JSON.stringify(rules)) invalid();
  for (const change of patch.changes) {
    if (change.path <= previous || JSON.stringify(change.before) === JSON.stringify(change.after)) invalid();
    previous = change.path;
    for (const file of [change.before, change.after]) if (file && (file.text.includes('\0') || patchDigest(file.text) !== file.digest)) invalid();
  }
}).readonly();
export type WorkspacePatch = z.infer<typeof workspacePatchSchema>;
export interface PatchLimits { readonly maxBytes: number; readonly maxEntries: number; readonly maxDepth: number; readonly maxPathBytes: number }
