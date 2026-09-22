import { createHash } from 'node:crypto';
import { z } from 'zod';
import { attemptIdentitySchema } from '#domain/index.js';
import { workspaceSourceSchema } from '#engine/core/workspaces/index.js';
import rules from './rules.json' with { type: 'json' };
/** Bounded reason for PATCH_LIMIT: which configured budget or Git output bound was exceeded. Never carries paths or content. */
export type WorkspacePatchLimitDetail = 'git-output' | 'git-timeout' | 'time' | 'bytes' | 'entries' | 'depth' | 'path';
export class WorkspacePatchError extends Error {
  constructor(readonly code: 'PATCH_INTEGRATION_PENDING' | 'PATCH_UNAVAILABLE' | 'PATCH_UNSAFE' | 'PATCH_LIMIT' | 'PATCH_UNSUPPORTED' | 'PATCH_CONFLICT' | 'PATCH_CORRUPT',
    readonly detail?: WorkspacePatchLimitDetail) {
    super(code); this.name = 'WorkspacePatchError';
  }
}
export const patchDigest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const patchExclusions = Object.freeze(rules);
export function isPatchExcluded(path: string) {
  return path.split('/').some(part => rules.excludedSegments.includes(part) || rules.excludedPrefixes.some(prefix => part.startsWith(prefix)));
}
export const patchPathSchema = z.string().min(1).refine(path => !path.includes('\\') && [...path].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..') && !isPatchExcluded(path));
const fileSchema = z.object({ mode: z.enum(['100644', '100755']), text: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();
export type PatchFile = z.infer<typeof fileSchema>;
export function patchFile(bytes: Uint8Array, mode: PatchFile['mode']): PatchFile {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new WorkspacePatchError('PATCH_UNSUPPORTED'); }
  if (text.includes('\0')) throw new WorkspacePatchError('PATCH_UNSUPPORTED');
  return Object.freeze({ mode, text, digest: patchDigest(bytes) });
}
export const workspacePatchSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('workspace-patch'),
  identity: attemptIdentitySchema, source: workspaceSourceSchema, baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  exclusions: z.object({ excludedSegments: z.array(z.string()), excludedPrefixes: z.array(z.string()) }).strict(),
  changes: z.array(z.object({ path: patchPathSchema, before: fileSchema.nullable(), after: fileSchema.nullable() }).strict().readonly()),
}).strict().superRefine((patch, context) => {
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
