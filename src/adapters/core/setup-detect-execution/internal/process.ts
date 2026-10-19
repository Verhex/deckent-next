import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

export type DetectEnvironment = Readonly<Record<string, string | undefined>>;
/** One bounded read-only command: `code` is null when it did not run to an exit (absent, timed out, output over the bound, aborted). */
export type DetectProcessResult = Readonly<{ code: number | null; stdout: string; stderr: string }>;
export type DetectRunner = (executable: string, args: readonly string[], options: Readonly<{ env: DetectEnvironment; cwd?: string; timeoutMs: number;
  outputBytes: number; signal: AbortSignal }>) => Promise<DetectProcessResult>;
/** The detection process boundary: no shell, its own deadline and output bound, never throws (setup reports a probe; it does not fail on one). */
export const runDetectCommand: DetectRunner = (executable, args, options) => new Promise(done => {
  const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  execFile(executable, [...args], { env, encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: options.outputBytes, signal: options.signal,
    ...(options.cwd ? { cwd: options.cwd } : {}) }, (error, stdout, stderr) => {
    const failure = error as (Error & { code?: unknown; killed?: boolean }) | null;
    done({ code: !failure ? 0 : typeof failure.code === 'number' && !failure.killed ? failure.code : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});
/** The first executable file of this name in PATH order (what a shell would run); relative PATH entries are ignored; bounded; null if none. */
export async function findExecutable(name: string, env: DetectEnvironment, directories: number, signal: AbortSignal): Promise<string | null> {
  for (const directory of (env['PATH'] ?? '').split(delimiter).filter(entry => isAbsolute(entry)).slice(0, directories)) {
    if (signal.aborted) return null;
    const candidate = join(directory, name);
    if (await stat(candidate).then(info => info.isFile(), () => false) && await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}
