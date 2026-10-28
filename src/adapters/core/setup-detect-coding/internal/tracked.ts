import { findExecutable, runDetectCommand, type DetectEnvironment } from '#adapters/core/setup-detect-execution/index.js';
import registry from './coding.json' with { type: 'json' };
/**
 * U7 (audit C): whether Git tracks any of `paths` in the work tree holding `directory`, under the registry's read-only Git argv (no hooks, no
 * fsmonitor, no user/system config, bounded). `ls-files -z` lists exactly the tracked ones (`--error-unmatch` would fail on the first untracked
 * one and hide a tracked sibling). false: none tracked or not a repository; null: Git absent, timed out or refused — the caller fails closed.
 */
export async function gitTracksPaths(directory: string, paths: readonly string[], env: DetectEnvironment): Promise<boolean | null> {
  const { git, limits } = registry, signal = AbortSignal.timeout(limits.totalTimeoutMs);
  const gitPath = await findExecutable(git.executable, env, limits.pathDirectories, signal);
  if (!gitPath) return null;
  const result = await runDetectCommand(gitPath, [...git.prefix, 'ls-files', '-z', '--', ...paths],
    { env: git.env, cwd: directory, timeoutMs: limits.commandTimeoutMs, outputBytes: limits.outputBytes, signal });
  if (result.code === 0) return result.stdout.length > 0;
  return result.code !== null && result.stderr.includes(git.notRepository) ? false : null;
}
