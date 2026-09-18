import { createHash } from 'node:crypto';
import { z } from 'zod';

export const gitSourcePreimageSchema = z.object({ schemaVersion: z.literal(1), sourceRoot: z.string().min(1), repositoryRoot: z.string().min(1) }).strict().readonly();
export const gitSourceBaseSchema = z.object({ schemaVersion: z.literal(1), adapter: z.object({ id: z.literal('git'), version: z.literal(1) }).strict().readonly(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), source: gitSourcePreimageSchema,
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
}).strict().readonly();
export type GitSourcePreimage = z.infer<typeof gitSourcePreimageSchema>;
export type GitSourceBase = z.infer<typeof gitSourceBaseSchema>;
export function fingerprintGitSource(input: GitSourcePreimage) {
  return createHash('sha256').update(JSON.stringify(gitSourcePreimageSchema.parse(input))).digest('hex');
}
