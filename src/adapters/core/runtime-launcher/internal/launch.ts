import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const path = z.string().min(1).refine(value => !value.includes('\0') && isAbsolute(value));
const inputSchema = z.object({ executable: path, entry: path, cwd: path, logPath: path, env: z.record(z.string(), z.string()) }).strict();
export type DetachedRuntimeLaunchInput = z.infer<typeof inputSchema>;
export type RuntimeLauncherErrorCode = 'RUNTIME_LAUNCH_INVALID' | 'RUNTIME_LAUNCH_FAILED';
export class RuntimeLauncherError extends Error {
  constructor(readonly code: RuntimeLauncherErrorCode, options?: ErrorOptions) { super(code, options); this.name = 'RuntimeLauncherError'; }
}

/** Starts `<entry> runtime serve` as a detached background process of the same executable and user: no shell, no stdin,
 * stdout/stderr appended to a private (0600, no-follow) log. The caller owns readiness; this never waits for or adopts it.
 * The process outlives the caller by design (owner 2026-09-23); `deckent runtime shutdown` is its stop path. */
export async function launchDetachedRuntimeService(raw: DetachedRuntimeLaunchInput): Promise<{ readonly pid: number }> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new RuntimeLauncherError('RUNTIME_LAUNCH_INVALID');
  const input = parsed.data;
  const log = await open(input.logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    .catch(cause => { throw new RuntimeLauncherError('RUNTIME_LAUNCH_FAILED', { cause }); });
  try {
    const child = spawn(input.executable, [input.entry, 'runtime', 'serve'], { cwd: input.cwd, env: input.env, detached: true, shell: false,
      stdio: ['ignore', log.fd, log.fd] });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', cause => reject(new RuntimeLauncherError('RUNTIME_LAUNCH_FAILED', { cause })));
      child.once('spawn', () => resolve(child.pid!));
    });
    child.unref();
    return Object.freeze({ pid });
  } finally { await log.close(); }
}
