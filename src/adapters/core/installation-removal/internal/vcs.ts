import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { GIT_LOCAL_ENV, localGitArgs } from '#engine/index.js';
import { pathWithin } from '#platform/index.js';
import { removalRegistry } from './inventory.js';
const executable = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
const inRepository = (path: string): boolean => existsSync(join(path, '.git')) || dirname(path) !== path && inRepository(dirname(path));
export type ProjectTracking = (path: string) => 'vcs-tracked' | 'vcs-unverified' | null;
/** K1(e): what the project's VCS tracks is the person's or team's, never a removal member: a path (or anything below it) that Git tracks is kept.
 * Git runs hardened (absolute executable, no shell, local-only env and args: no hooks, fsmonitor, system/global config or replace objects,
 * literal pathspecs), bounded. Tracking that cannot be read inside a repository leaves every project path possibly tracked: kept and listed. */
export async function projectTracking(projectRoot: string, projectData: string, configured: string | null, bounds: { readonly timeoutMs: number; readonly outputBytes: number }): Promise<ProjectTracking> {
  const git = configured ?? removalRegistry.git.find(executable), unverified: ProjectTracking = path => pathWithin(projectRoot, path) ? 'vcs-unverified' : null;
  if (!git || !isAbsolute(git)) return inRepository(projectRoot) ? unverified : () => null;
  const answer = await new Promise<{ out: string; err: string; code: unknown }>(resolve => execFile(git, localGitArgs(projectRoot, ['--literal-pathspecs', 'ls-files', '-z', '--', projectData]),
    { env: { ...GIT_LOCAL_ENV, LC_ALL: 'C' }, shell: false, encoding: 'utf8', timeout: bounds.timeoutMs, maxBuffer: bounds.outputBytes }, (error, out, err) => resolve({ out, err, code: error ? error.code ?? -1 : 0 })));
  // Git itself saying there is no repository is an answer (a stray `.git` folder is no repository); any other failure is not.
  if (answer.code === 128 && /not a git repository/u.test(answer.err)) return () => null;
  if (answer.code !== 0) return unverified;
  const files = answer.out.split('\0').filter(Boolean).map(path => join(projectRoot, path));
  return path => files.some(file => pathWithin(path, file)) ? 'vcs-tracked' : null;
}
