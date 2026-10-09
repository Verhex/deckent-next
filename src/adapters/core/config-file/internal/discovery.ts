import { access, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { probeDockerImageAvailability, runNodeDockerCommand, type DockerCommandRunner } from '#adapters/core/docker-supervisor/index.js';
const exec = promisify(execFile);
export interface ConfigDiscoveryLimits { readonly timeoutMs: number; readonly outputBytes: number; readonly maxEntries: number }
/**
 * Scan bounds beside the caller's limits (Astra 2456): at most this many PATH directories are probed, and a directory listing reads at most
 * `maxEntries × CONFIG_DISCOVERY_SCAN_FACTOR` entries (every entry seen counts, not only matches); both stop at the limits' `timeoutMs`.
 */
export const CONFIG_DISCOVERY_BOUNDS = Object.freeze({ pathDirectories: 256, scanFactor: 16 });
/** Discovery never starts a shell, mutates Git, pulls an image or opens a ledger writer. */
export async function discoverConfigExecutables(name: 'docker' | 'git', env: NodeJS.ProcessEnv, limits: Pick<ConfigDiscoveryLimits, 'timeoutMs'>): Promise<readonly string[]> {
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const paths = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean).slice(0, CONFIG_DISCOVERY_BOUNDS.pathDirectories), extensions = process.platform === 'win32' ? (env['PATHEXT'] ?? '.EXE').split(';').filter(extension => extension.toLowerCase() === '.exe') : [''];
  const candidates = [...new Set(paths.flatMap(path => extensions.map(extension => resolve(path, name + extension))))];
  const probes = Promise.all(candidates.map(async path => { try { await access(path, constants.X_OK); return path; } catch { return null; } }));
  // The whole probe shares one deadline: a hung network mount answers nothing rather than holding the window.
  const expired = new Promise<null>(resolve => { if (deadline.aborted) resolve(null); else deadline.addEventListener('abort', () => resolve(null), { once: true }); });
  const observed = await Promise.race([probes, expired]);
  return (observed ?? []).filter((path): path is string => path !== null);
}
export async function discoverConfigBranches(executable: string, root: string, env: NodeJS.ProcessEnv, limits: ConfigDiscoveryLimits): Promise<readonly string[]> {
  const result = await exec(executable, ['for-each-ref', '--format=%(refname)', 'refs/heads/'], { cwd: root, env, encoding: 'utf8', timeout: limits.timeoutMs, maxBuffer: limits.outputBytes });
  return result.stdout.trim().split('\n').filter(value => /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/u.test(value)).slice(0, limits.maxEntries);
}
export async function discoverConfigImages(executable: string, limits: ConfigDiscoveryLimits, runner: DockerCommandRunner = runNodeDockerCommand): Promise<readonly string[]> {
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const bounded: DockerCommandRunner = command => runner(command, deadline);
  const output = await bounded({ executable, args: ['image', 'ls', '--no-trunc', '--quiet'], ...limits });
  const ids = [...new Set(output.stdout.trim().split('\n'))].filter(id => /^sha256:[a-f0-9]{64}$/u.test(id)).slice(0, limits.maxEntries);
  const images: string[] = [];
  for (const imageId of ids) {
    deadline.throwIfAborted();
    try { await probeDockerImageAvailability({ executable, imageId, ...limits }, bounded); images.push(imageId); } catch { /* Changed/unavailable images are never proposed. */ }
    deadline.throwIfAborted();
  }
  return images;
}
export async function discoverConfigFiles(directory: string, limits: ConfigDiscoveryLimits): Promise<readonly string[]> {
  const paths: string[] = [], deadline = Date.now() + limits.timeoutMs, scanLimit = limits.maxEntries * CONFIG_DISCOVERY_BOUNDS.scanFactor;
  let scanned = 0;
  for await (const entry of await opendir(directory)) {
    if (entry.isFile()) paths.push(join(directory, entry.name));
    if (paths.length >= limits.maxEntries || ++scanned >= scanLimit || Date.now() >= deadline) break;
  }
  return paths;
}
export function discoverConfigPools(path: string, busyTimeoutMs: number, maxEntries: number): readonly string[] {
  const db = new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(path, { readOnly: true }); // lazy: SDK import never loads it
  try { db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`); return db.prepare('SELECT pool_id FROM execution_pools ORDER BY pool_id LIMIT ?').all(maxEntries).map(row => String(row['pool_id'])); }
  finally { db.close(); }
}
