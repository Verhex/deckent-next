import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { z } from 'zod';
import type { GIT_EXECUTION_SETTINGS, WORK_TARGET_SETTINGS } from '#platform/index.js';
import { assertWorkTarget, type WorkTargetObservation } from '#engine/index.js';
import { GIT_LOCAL_ENV, localGitArgs } from './local-git.js';
const exec = promisify(execFile);
type GitSettings = z.infer<typeof GIT_EXECUTION_SETTINGS>;
export type WorkTargetSettings = z.infer<typeof WORK_TARGET_SETTINGS>;
export type WorkTargetDeclaration = WorkTargetSettings['targets'][number];
/** The configured execution section as far as work-target resolution reads it. */
export interface WorkTargetExecution { readonly git: Pick<GitSettings, 'gitExecutable' | 'timeoutMs' | 'outputBytes'>; readonly workTargets?: WorkTargetSettings | undefined }
/** Where coding work runs. `id` null = no configured target: the project root and its checkout HEAD, exactly as before work targets. */
export interface ResolvedGitWorkTarget { readonly id: string | null; readonly git: Readonly<{ sourceRoot: string; baseRef?: string }> }

/** The single selection of the target a Run uses (slice 1: the one configured target), without touching the filesystem. */
export function selectWorkTarget(execution: Pick<WorkTargetExecution, 'workTargets'> | null | undefined): WorkTargetDeclaration | null {
  return execution?.workTargets?.targets[0] ?? null;
}
async function canonical(path: string) { try { return await realpath(path); } catch { return null; } }
/** Bounded local Git read with the package's network/hook/config denial; failure is an unobserved fact, never a thrown path. */
async function read(git: WorkTargetExecution['git'], root: string, args: string[]) {
  try {
    return (await exec(git.gitExecutable, localGitArgs(root, args), { env: GIT_LOCAL_ENV, timeout: git.timeoutMs, maxBuffer: git.outputBytes, encoding: 'utf8' })).stdout.trim();
  } catch { return null; }
}
async function commonDirectory(git: WorkTargetExecution['git'], root: string) {
  const value = await read(git, root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return value ? canonical(value) : null;
}
/** Observes a target without trusting it: Git runs only inside a canonical, owned, not group/other-writable directory. */
async function observe(git: WorkTargetExecution['git'], target: WorkTargetDeclaration): Promise<WorkTargetObservation> {
  const realPath = await canonical(target.path);
  const unobserved = { path: target.path, realPath, safeDirectory: false, repositoryRoot: null, bare: null, commonDirectory: null, alternates: null, baseCommit: null };
  if (realPath === null || realPath !== target.path) return unobserved;
  const stat = await lstat(realPath);
  const safeDirectory = stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0;
  if (!safeDirectory) return unobserved;
  const bareText = await read(git, realPath, ['rev-parse', '--is-bare-repository']);
  const top = bareText === 'false' ? await read(git, realPath, ['rev-parse', '--show-toplevel']) : null;
  const common = await commonDirectory(git, realPath);
  let alternates: boolean | null = null;
  if (common) { try { await lstat(join(common, 'objects', 'info', 'alternates')); alternates = true; } catch (error) { alternates = (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null; } }
  const commit = await read(git, realPath, ['rev-parse', '--verify', '--quiet', `${target.baseRef}^{commit}`]);
  return { path: target.path, realPath, safeDirectory, repositoryRoot: top ? await canonical(top) : null, bare: bareText === null ? null : bareText === 'true',
    commonDirectory: common, alternates, baseCommit: commit && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) ? commit : null };
}
/** One resolver for every acquisition site (Run base capture, execution, patch, integration, delivery, adoption, delivery-pinned Runs)
 * and the service start. Without a configured target it returns `projectRoot` exactly as the caller passed it and runs nothing.
 * With one, every call re-observes the target and applies the typed refusals (`WorkTargetError`); config is re-read per operation. */
export async function resolveGitWorkTarget(projectRoot: string, execution: WorkTargetExecution | null | undefined,
  layout: { readonly root: string; readonly bootstrapConfigPath: string }): Promise<ResolvedGitWorkTarget> {
  const target = selectWorkTarget(execution);
  if (!target || !execution) return Object.freeze({ id: null, git: Object.freeze({ sourceRoot: projectRoot }) });
  const project = await canonical(projectRoot) ?? projectRoot;
  // Product data: the layout root and the directory of the fixed resources (the project's configuration directory).
  const roots = await Promise.all([layout.root, dirname(layout.bootstrapConfigPath)].map(async root => await canonical(root) ?? root));
  assertWorkTarget(await observe(execution.git, target), { projectRoot: project, projectCommonDirectory: await commonDirectory(execution.git, project), dataRoots: roots });
  return Object.freeze({ id: target.id, git: Object.freeze({ sourceRoot: target.path, baseRef: target.baseRef }) });
}
