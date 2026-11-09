import { persistedString, attemptIdentitySchema } from '#domain/index.js';
import { GIT_EXECUTION_SETTINGS } from '#platform/index.js';
import { WorkspaceError, workspaceRequestSchema, type WorkspaceRequest } from './port.js';
import { isAbsolute, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const gitSourcePreimageSchema = z.strictObject({ schemaVersion: z.literal(1), sourceRoot: persistedString(z.string().min(1)), repositoryRoot: persistedString(z.string().min(1)) }).readonly();
export const gitSourceBaseSchema = z.strictObject({ schemaVersion: z.literal(1), adapter: z.strictObject({ id: z.literal('git'), version: z.union([z.literal(1), z.literal(2)]) }).readonly(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), source: gitSourcePreimageSchema,
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
}).readonly();
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type GitSourcePreimage = z.infer<typeof gitSourcePreimageSchema>;
export type GitSourceBase = z.infer<typeof gitSourceBaseSchema>;
export function fingerprintGitSource(input: GitSourcePreimage) {
  return createHash('sha256').update(JSON.stringify(gitSourcePreimageSchema.parse(input))).digest('hex');
}

/** `baseRef` (WORK-TARGETS): a configured work target's base branch. Present, a Run's base is its tip and delivery/integration compare
 * against it; absent, the source checkout's HEAD as before (the option is then not part of any fingerprint). */
export const gitWorkspaceOptionsSchema = GIT_EXECUTION_SETTINGS.extend({ sourceRoot: persistedString(z.string().min(1)), workspaceRoot: persistedString(z.string().min(1)),
  baseRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/).optional(),
  /** Owner 2026-11-05 (R9p): no work target and `deliveryMode` working-tree: integration compares, and the working-tree delivery target writes,
   * the source checkout's files instead of HEAD and its index. Never part of a clone fingerprint (the broker drops it). */
  workingTree: z.literal(true).optional(),
  /** Owner 2026-11-05 (R9n): the Run's private base repository (Deckent-owned, `captureWorkingTreeBase`). Present, Run bases are read from
   * and cloned out of it and are adapter version 2; the person's repository is only read. Never part of a clone fingerprint (the broker drops it). */
  runBase: persistedString(z.string().min(1)).optional() }).strict().readonly();
export type GitWorkspaceOptions = z.infer<typeof gitWorkspaceOptionsSchema>;
export const gitWorkspaceRecordSchema = z.strictObject({ schemaVersion: z.literal(2), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  request: workspaceRequestSchema, sourceBase: gitSourceBaseSchema, status: z.enum(['allocating', 'ready']) });
export function gitWorkspaceFingerprint(request: WorkspaceRequest, sourceBase: GitSourceBase, options: GitWorkspaceOptions, privateSource?: Readonly<{ repositoryRoot: string; baseCommit: string }>) {
  return createHash('sha256').update(JSON.stringify({ request, sourceBase, options, ...(privateSource ? { privateSource } : {}) })).digest('hex');
}
export function validGitSourceBase(sourceBase: GitSourceBase, request: WorkspaceRequest) {
  return fingerprintGitSource(sourceBase.source) === sourceBase.sourceFingerprint && sourceBase.baseCommit === request.baseCommit
    && [sourceBase.source.sourceRoot, sourceBase.source.repositoryRoot].every(path => isAbsolute(path) && resolve(path) === path);
}

export function gitWorkspaceIdentityTarget(input: unknown, workspaceRoot: string, format: { checkout: string; lease: string }) {
    const identity = attemptIdentitySchema.safeParse(input);
    if (!identity.success) throw new WorkspaceError('WORKSPACE_REQUEST_INVALID');
    const id = createHash('sha256').update(JSON.stringify(identity.data)).digest('hex');
    const directory = join(workspaceRoot, id);
    return { identity: identity.data, id, directory, workspace: join(directory, format.checkout), lease: join(directory, format.lease) };
  }
export function gitWorkspaceRequestTarget(input: WorkspaceRequest, workspaceRoot: string, format: { checkout: string; lease: string }) {
    const parsed = workspaceRequestSchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceError('WORKSPACE_REQUEST_INVALID');
    const request = parsed.data;
    const { id, directory, workspace, lease } = gitWorkspaceIdentityTarget(request.identity, workspaceRoot, format);
    return { request, id, directory, workspace, lease };
  }
