import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { SupervisorError } from '#engine/index.js';

/** Container paths a dependency bind may never cover: the delivered tree (`/workspace`) must stay exactly the verified commit, and the
 * scratch, task-input, connection and kernel mounts belong to the supervisor. */
const RESERVED_TARGETS = Object.freeze(['/workspace', '/tmp', '/deckent', '/run', '/proc', '/sys', '/dev']);
const unsafe = /[,\0\r\n]/u;
const SEGMENT = /^[A-Za-z0-9._@+-]{1,255}$/u;
/** Project-relative source: normalized, no parent/current segment, never a Git or Deckent product directory. */
const sourceSchema = z.string().max(512).refine(value => value.split('/').every(part => SEGMENT.test(part)
  && part !== '.' && part !== '..' && part !== '.git' && part !== '.deckent'));
export const dockerMountTargetSchema = z.string().max(512).refine(value => value.startsWith('/') && value !== '/' && !unsafe.test(value)
  && posix.normalize(value) === value && !value.endsWith('/') && !RESERVED_TARGETS.some(reserved => value === reserved || value.startsWith(reserved + '/')));
const uniqueTargets = (mounts: readonly { readonly target: string }[]) => new Set(mounts.map(mount => mount.target)).size === mounts.length;
/** Task profile data (pinned with the Run, part of its profile fingerprint). There is no writable form: every bind is read-only. */
export const dockerReadOnlyMountsSchema = z.array(z.object({ source: sourceSchema, target: dockerMountTargetSchema }).strict().readonly())
  .max(8).refine(uniqueTargets).readonly();
/** Supervisor option: the same binds with sources resolved by trusted composition to real absolute host directories. */
export const dockerResolvedMountsSchema = z.array(z.object({ source: z.string().min(1).max(4096).refine(value => isAbsolute(value) && !unsafe.test(value)),
  target: dockerMountTargetSchema }).strict().readonly()).max(8).refine(uniqueTargets).readonly();
export type DockerReadOnlyMount = z.infer<typeof dockerReadOnlyMountsSchema>[number];

const inside = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)); };
/** A bind source must be a real directory (no link anywhere on its path) that neither contains nor lies inside a guarded host path. */
export async function assertReadOnlyMountSource(source: string, guarded: readonly string[]): Promise<void> {
  const invalid = new SupervisorError('SUPERVISOR_REQUEST_INVALID');
  let real: string; try { real = await realpath(source); } catch { throw invalid; }
  if (real !== source || unsafe.test(source) || !(await lstat(source)).isDirectory()) throw invalid;
  if (guarded.some(path => inside(path, source) || inside(source, path))) throw invalid;
}
/** Resolves profile binds against the trusted project root before any dispatch (B06-2c). `excluded` names product data (layout root and
 * resources): a bind can expose neither the ledger, keys and approvals nor other attempts' workspaces to a task. */
export async function resolveDockerReadOnlyMounts(projectRoot: string, mounts: readonly DockerReadOnlyMount[], excluded: readonly string[]) {
  const parsed = dockerReadOnlyMountsSchema.safeParse(mounts);
  if (!parsed.success) throw new SupervisorError('SUPERVISOR_REQUEST_INVALID');
  let root: string; try { root = await realpath(projectRoot); } catch { throw new SupervisorError('SUPERVISOR_REQUEST_INVALID'); }
  const guarded = await Promise.all(excluded.map(path => realpath(path).catch(() => resolve(path))));
  const resolved = [];
  for (const mount of parsed.data) {
    const source = join(root, ...mount.source.split('/'));
    await assertReadOnlyMountSource(source, guarded);
    resolved.push(Object.freeze({ source, target: mount.target }));
  }
  return Object.freeze(resolved);
}
