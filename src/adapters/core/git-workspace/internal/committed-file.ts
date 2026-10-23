import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { GIT_LOCAL_ENV, localGitArgs } from './local-git.js';
import { resolveGitWorkTarget, selectWorkTarget, type WorkTargetExecution } from './work-target.js';
const exec = promisify(execFile);
/** Tree entry modes (git ls-tree): only a tree may hold the file and only a plain blob is read; a link (120000) or submodule (160000) is unsafe. */
const MODE = Object.freeze({ tree: '040000', blobs: ['100644', '100755'] });
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

async function git(settings: WorkTargetExecution['git'], root: string, args: readonly string[], maxBuffer: number): Promise<Buffer> {
  // --literal-pathspecs: a registry file name is a path, never a pathspec pattern.
  return (await exec(settings.gitExecutable, localGitArgs(root, ['--literal-pathspecs', ...args]), { env: GIT_LOCAL_ENV, timeout: settings.timeoutMs, maxBuffer, encoding: 'buffer' })).stdout;
}
/** One entry of `tree` named exactly `name` (ls-tree -z -l), or null when the tree has none. */
async function entry(settings: WorkTargetExecution['git'], root: string, tree: string, name: string) {
  const out = (await git(settings, root, ['ls-tree', '-z', '-l', tree, '--', name], settings.outputBytes)).toString('utf8');
  if (!out) return null;
  const tab = out.indexOf('\t'), match = /^(\d{6}) (\w+) ([a-f0-9]+) +(-|\d+)$/u.exec(out.slice(0, tab));
  if (tab < 0 || !match || out.slice(tab + 1) !== `${name}\0` || !OID.test(match[3]!)) throw new Error('unreadable');
  return { mode: match[1]!, oid: match[3]!, size: match[4] === '-' ? null : Number(match[4]) };
}
/** Git's object id of a blob: sha1 or sha256 (by the repository's id length) over `blob <size>\0<bytes>`. */
const blobOid = (bytes: Buffer, length: number) => createHash(length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * alpha.54 R1: reads a registry-named file from the commit `commit()` resolves for `ref` in the work target at `root`, never the working tree.
 * Each directory on the way must be a tree; the file must be a plain blob whose tree-listed size is within `maxBytes` before any read; the
 * read blob's object id is recomputed and must be the listed one. A Git failure is `unreadable`, never an absent file.
 */
export function gitRefFileSource(settings: WorkTargetExecution['git'], root: string, ref: string, commit: () => Promise<string>) {
  return { ref, async read(name: string, maxBytes: number) {
    const at = await commit();
    if (!OID.test(at)) throw new Error('unreadable');
    const parts = name.split('/'), file = parts.pop()!;
    let tree = at;
    try {
      for (const part of parts) {
        const found = await entry(settings, root, tree, part);
        if (found === null) return null;
        if (found.mode !== MODE.tree) throw new Error('unsafe');
        tree = found.oid;
      }
      const found = await entry(settings, root, tree, file);
      if (found === null) return null;
      if (!MODE.blobs.includes(found.mode) || found.size === null) throw new Error('unsafe');
      if (found.size > maxBytes) throw new Error('size');
      const bytes = await git(settings, root, ['cat-file', 'blob', found.oid], maxBytes + 1);
      if (bytes.length !== found.size || blobOid(bytes, found.oid.length) !== found.oid) throw new Error('unreadable');
      return { commit: at, blobOid: found.oid, bytes };
    } catch (error) {
      throw error instanceof Error && (error.message === 'unsafe' || error.message === 'size') ? error : new Error('unreadable');
    }
  } };
}
/** The configured work target's base ref as a committed source: every read resolves the commit through the work target's own checks
 * (`resolveGitWorkTarget`, the same refusals a Run meets). Undefined without a configured target: the caller reads the working tree. */
export function workTargetRefFileSource(projectRoot: string, execution: WorkTargetExecution | null | undefined, layout: Parameters<typeof resolveGitWorkTarget>[2]) {
  const target = selectWorkTarget(execution);
  return target && execution ? gitRefFileSource(execution.git, target.path, target.baseRef,
    async () => (await resolveGitWorkTarget(resolve(projectRoot), execution, layout)).baseCommit ?? '') : undefined;
}
