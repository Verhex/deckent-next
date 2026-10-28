import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, readlink } from 'node:fs/promises';
import { isAbsolute, dirname, parse, resolve, sep } from 'node:path';
import { z } from 'zod';
import { BeuserContractError, type BeuserContext } from '#engine/core/beuser-contract/index.js';
import { beuserBindingDigest, type BeuserRealmHandle } from '#engine/core/beuser-realm/index.js';
import recipe from './recipe.json' with { type: 'json' };

// Physical unit conversion, independent of policy/resource ceilings.
export const NANOSECONDS_PER_SECOND = 1_000_000_000;
export const BEUSER_REALM_RECIPE = Object.freeze(recipe);
const positive = z.number().int().positive().safe();
const optionsSchema = z.object({ controllerRoot: z.string(), packageRoot: z.string(), executable: z.string(),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/u), uid: positive, gid: positive,
  memoryBytes: positive, nanoCpus: positive, pids: positive, filesystemBytes: positive,
}).strict().readonly();
export type BeuserRealmOptions = z.infer<typeof optionsSchema>;
export interface BeuserRealmCommand {
  (args: readonly string[], context: BeuserContext): Promise<string>;
}
export class BeuserContainerMissing extends Error {
  constructor(readonly containerId: string) { super('BEUSER_CONTAINER_MISSING'); }
}
export const refuseRealm = (): never => { throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'); };
export function pinRealmOptions(value: unknown): BeuserRealmOptions {
  const parsed = optionsSchema.safeParse(value);
  if (!parsed.success || process.platform !== 'linux') return refuseRealm();
  return parsed.data;
}
/** No path from a surface command reaches here. Reject normalization, symlinks in any component and alias roots. */
export async function canonicalRealmPath(path: string, kind: 'directory' | 'file'): Promise<string> {
  if (!isAbsolute(path) || path === parse(path).root || resolve(path) !== path || Array.from(path).some(char => char.charCodeAt(0) < 32 || char === ',')) return refuseRealm();
  for (let segmentPath = path; segmentPath !== dirname(segmentPath); segmentPath = dirname(segmentPath)) {
    const info = await lstat(segmentPath);
    if (info.isSymbolicLink() || (segmentPath !== path && !info.isDirectory())) return refuseRealm();
  }
  const info = await lstat(path);
  if (await realpath(path) !== path || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) return refuseRealm();
  return path;
}
export function pathContains(parent: string, child: string) { return child === parent || child.startsWith(parent + sep); }
export const realmFileIdentity = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  return `${info.dev}:${info.ino}`;
};
export async function privateControllerRoot(path: string) {
  await canonicalRealmPath(path, 'directory');
  const info = await lstat(path);
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) return refuseRealm();
}
/** Explicit executable, clean environment, no shell, bounded output/time and SIGKILL on cancellation/timeout. */
export function dockerRealmCommand(options: BeuserRealmOptions): BeuserRealmCommand {
  return async (args, context) => {
    context.signal.throwIfAborted();
    await canonicalRealmPath(options.executable, 'file');
    for (let parent = dirname(options.executable); ; parent = dirname(parent)) {
      const owner = await lstat(parent);
      if (owner.uid !== 0 || (owner.mode & 0o022)) return refuseRealm();
      if (parent === dirname(parent)) break;
    }
    const file = await open(options.executable, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if ((info.mode & 0o022) || (info.mode & 0o6000) || !(info.mode & 0o111) || info.uid !== 0) return refuseRealm();
    } finally { await file.close(); }
    return new Promise<string>((done, fail) => {
      execFile(options.executable, [...args], { env: {}, shell: false, encoding: 'utf8', signal: context.signal,
        timeout: context.limits.maxWaitMs, maxBuffer: context.limits.maxArtifactBytes, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (!error) return done(stdout);
        const id = args.at(-1);
        if (error.code === 1 && args[0] === 'container' && args[1] === 'inspect' && id && /^[a-f0-9]{64}$/u.test(id)
          && stderr.trim() === `Error response from daemon: No such container: ${id}`) return fail(new BeuserContainerMissing(id));
        fail(new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'));
      });
    });
  };
}
export async function namespaceReadback() {
  const names = ['mnt', 'pid', 'net', 'ipc', 'uts', 'cgroup'] as const;
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await readlink(`/proc/self/ns/${name}`)])));
}
export function checkHandle(context: BeuserContext, handle: BeuserRealmHandle) {
  if (!/^[a-f0-9]{64}$/u.test(handle.containerId) || !z.string().uuid().safeParse(handle.incarnation).success
    || beuserBindingDigest(context.binding) !== beuserBindingDigest(handle.binding)) return refuseRealm();
}
