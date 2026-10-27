import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { removalRegistry } from './inventory.js';
const executable = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
const inRepository = (path: string): boolean => existsSync(join(path, '.git')) || dirname(path) !== path && inRepository(dirname(path));
/** K1(e): files the project's VCS tracks belong to the person or team and are never removal members. Git runs by absolute path (configured, else
 * the registry's), without a shell, bounded. Tracking that cannot be read inside a repository is `unavailable`: the data tier stops. */
export async function trackedProjectFiles(projectRoot: string, projectData: string, configured: string | null, bounds: { readonly timeoutMs: number; readonly outputBytes: number }) {
  const git = configured ?? removalRegistry.git.find(executable), none = { files: new Set<string>(), unavailable: false };
  if (!git) return { ...none, unavailable: inRepository(projectRoot) };
  const answer = await new Promise<{ out: string; err: string; code: unknown }>(resolve => execFile(git, ['-C', projectRoot, 'ls-files', '-z', '--', projectData], { env: { LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0' }, shell: false, encoding: 'utf8', timeout: bounds.timeoutMs, maxBuffer: bounds.outputBytes }, (error, out, err) => resolve({ out, err, code: error ? error.code ?? -1 : 0 })));
  if (answer.code === 128 && /not a git repository/u.test(answer.err)) return none;
  return { files: new Set(answer.out.split('\0').filter(Boolean).map(path => join(projectRoot, path))), unavailable: answer.code !== 0 };
}
