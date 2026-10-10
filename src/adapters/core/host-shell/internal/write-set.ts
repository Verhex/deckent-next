import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxWriteChange, SandboxWriteRefusal, SandboxWriteSetScan } from '#engine/index.js';
export { applySandboxWriteSet, describeSandboxWriteSet, type SandboxWriteCell, type SandboxWriteChange, type SandboxWriteDecider,
  type SandboxWriteDecision, type SandboxWriteRefusal, type SandboxWriteSetReport, type SandboxWriteSetScan } from '#engine/index.js';
import { normalizeGlobalScopePlatform, prepareProductDirectory, productResourcePath, resolveGlobalScopePaths, resolveProductLayout, type ProductLayout } from '#platform/index.js';

/**
 * SHELL-OVERLAY bounds of one sandbox write set (fail closed: over any of them the whole set is refused, never partly applied): entries
 * listed in the upper directory plus the lower files a deleted or replaced directory removes, the bytes of all written files, one file.
 */
export const SANDBOX_WRITE_SET_BOUNDS = Object.freeze({ maxEntries: 2_000, maxTotalBytes: 64 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024, maxDepth: 32 });
const HELPER = fileURLToPath(new URL('../native/build/Release/shell-overlay-scan', import.meta.url));
const HELPER_TIMEOUT_MS = 10_000;

interface UpperEntry { readonly type: string; readonly mode: number; readonly nlink: number; readonly size: number; readonly rdev: readonly [number, number];
  readonly flags: string; readonly rel: string }

/** Runs the native lister (it reads the overlay xattrs Node cannot) and parses its NUL-terminated records. */
function listUpper(upper: string, maxEntries: number): Promise<{ readonly ok: true; readonly entries: readonly UpperEntry[] } | { readonly ok: false; readonly reason: string }> {
  return new Promise(resolve => {
    execFile(HELPER, [upper, String(maxEntries)], { encoding: 'buffer', maxBuffer: maxEntries * 4_200 + 65_536, timeout: HELPER_TIMEOUT_MS, env: {} }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as { code?: unknown }).code;
        resolve({ ok: false, reason: code === 3 ? `more than ${maxEntries} entries` : `the write set could not be listed (${String(stderr).trim().split('\n')[0] || String(code)})` });
        return;
      }
      const entries: UpperEntry[] = [];
      for (const record of stdout.toString('utf8').split('\0')) {
        if (record === '') continue;
        const match = /^([fdlcbps?]) ([0-7]+) (\d+) (\d+) (\d+) (\d+) ([-ormw]+) (.+)$/su.exec(record);
        if (!match) { resolve({ ok: false, reason: 'the write set listing was not understood' }); return; }
        entries.push({ type: match[1]!, mode: Number.parseInt(match[2]!, 8), nlink: Number(match[3]), size: Number(match[4]), rdev: [Number(match[5]), Number(match[6])],
          flags: match[7]!, rel: match[8]! });
      }
      resolve({ ok: true, entries });
    });
  });
}

const sha256File = async (path: string): Promise<string | null> => {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally { await handle.close(); }
};

/**
 * Reads the change set a sandboxed command left in its overlay upper directory (SHELL-OVERLAY, design §4–§5), against the real project
 * (`lower`). Called only after the command and every process it started ended (the PID namespace ends with the call), on Deckent's own
 * private directory. Overlay semantics under `userxattr` (kernel forces `redirect_dir=nofollow`, `metacopy=off`): a `c 0:0` entry is a
 * whiteout (deletion); a directory marked opaque hides every lower entry it does not hold; a rename is a deletion plus a creation (no
 * redirects). `redirect`/`metacopy`/whiteout-xattr metadata never appears under those settings and refuses the whole set if it does.
 * Links, special files, hard-linked and setuid/setgid files are refused per entry. Lower paths are only `lstat`ed and hashed, never
 * followed. A lower path whose ctime is not older than `startMark` (the call directory's own ctime, same kernel clock) changed during
 * the call: it is a conflict.
 */
export async function scanSandboxWriteSet(upper: string, lower: string, startMark: bigint,
  bounds: typeof SANDBOX_WRITE_SET_BOUNDS = SANDBOX_WRITE_SET_BOUNDS): Promise<SandboxWriteSetScan> {
  const listed = await listUpper(upper, bounds.maxEntries);
  if (!listed.ok) return listed;
  const inUpper = new Map(listed.entries.map(entry => [entry.rel, entry] as const));
  const changes: SandboxWriteChange[] = [], refused: { rel: string; reason: SandboxWriteRefusal }[] = [], conflicts = new Set<string>();
  const emptyDirectories: string[] = [], directoryModes = new Map<string, number>(), newDirectories = new Set<string>();
  let count = listed.entries.length, bytes = 0;
  const over = () => count > bounds.maxEntries ? `more than ${bounds.maxEntries} entries` : bytes > bounds.maxTotalBytes ? `more than ${bounds.maxTotalBytes} bytes` : null;
  const lowerInfo = async (rel: string) => { try { return await lstat(join(lower, rel), { bigint: true }); } catch { return null; } };
  const changed = (info: { readonly ctimeNs: bigint }, rel: string) => { if (info.ctimeNs >= startMark) conflicts.add(rel); };
  /** A lower file removed (its version is the precondition); a lower link cannot be removed through the file target: refused. */
  const removeFile = async (rel: string): Promise<string | null> => {
    const info = await lowerInfo(rel);
    if (!info) return null;
    changed(info, rel);
    if (info.isSymbolicLink()) { refused.push({ rel, reason: 'symbolic-link' }); return null; }
    if (!info.isFile()) { refused.push({ rel, reason: 'special-file' }); return null; }
    const version = await sha256File(join(lower, rel));
    if (version === null) { refused.push({ rel, reason: 'not-a-regular-file' }); return null; }
    changes.push({ kind: 'delete', rel, lowerVersion: version });
    return null;
  };
  /** A lower directory removed (Astra 2180 R1: never outside the entry path); a directory changed during the call is a conflict. */
  const removeDirectory = async (rel: string) => {
    const info = await lowerInfo(rel);
    if (!info?.isDirectory()) return;
    changed(info, rel);
    changes.push({ kind: 'rmdir', rel });
  };
  /** Every lower entry under a deleted or replaced directory, except the names the upper still holds (`keep`), deepest directories last. */
  const removeTree = async (rel: string, depth: number, keep: (child: string) => boolean): Promise<string | null> => {
    if (depth > bounds.maxDepth) return 'a deleted directory is deeper than the bound';
    let names;
    try { names = await readdir(join(lower, rel), { withFileTypes: true }); } catch { return `a deleted directory could not be read (${rel})`; }
    for (const entry of names) {
      const child = posix.join(rel, entry.name);
      if (keep(child)) continue;
      if (++count > bounds.maxEntries) return over();
      if (entry.isDirectory()) {
        const refusedTree = await removeTree(child, depth + 1, () => false);
        if (refusedTree) return refusedTree;
        await removeDirectory(child);
      } else {
        const refusedFile = await removeFile(child);
        if (refusedFile) return refusedFile;
      }
    }
    return null;
  };
  for (const entry of listed.entries) {
    const { rel } = entry;
    if (/[rmw]/.test(entry.flags)) return { ok: false, reason: `unsupported overlay metadata (${rel})` };
    const below = await lowerInfo(rel);
    if (entry.type === 'c' && entry.rdev[0] === 0 && entry.rdev[1] === 0) {
      // Overlayfs writes a whiteout only over a lower entry that existed at the unlink: a lower that is gone now was removed during the call.
      if (!below) { conflicts.add(rel); continue; }
      if (below.isDirectory()) {
        const refusedTree = await removeTree(rel, 0, () => false);
        if (refusedTree) return { ok: false, reason: refusedTree };
        await removeDirectory(rel);
      } else await removeFile(rel);
      continue;
    }
    if (entry.type === 'd') {
      directoryModes.set(rel, entry.mode & 0o777);
      if (!below?.isDirectory()) newDirectories.add(rel);
      if (below && !below.isDirectory()) await removeFile(rel);
      else if (below && entry.flags.includes('o')) {
        // Opaque over a lower directory: what the lower holds and the upper does not is gone (the directory was removed and made again).
        const refusedTree = await removeTree(rel, 0, child => inUpper.has(child));
        if (refusedTree) return { ok: false, reason: refusedTree };
      }
      if (!below && !listed.entries.some(other => other.rel.startsWith(`${rel}/`))) emptyDirectories.push(rel);
      continue;
    }
    if (entry.type === 'l') { refused.push({ rel, reason: 'symbolic-link' }); continue; }
    if (entry.type !== 'f') { refused.push({ rel, reason: 'special-file' }); continue; }
    if (entry.nlink > 1) { refused.push({ rel, reason: 'hard-link' }); continue; }
    if ((entry.mode & 0o7000) !== 0) { refused.push({ rel, reason: 'setuid-setgid' }); continue; }
    if (entry.size > bounds.maxFileBytes) return { ok: false, reason: `a file is larger than ${bounds.maxFileBytes} bytes (${rel})` };
    bytes += entry.size;
    const tooMuch = over();
    if (tooMuch) return { ok: false, reason: tooMuch };
    const digest = await sha256File(join(upper, rel));
    if (digest === null) return { ok: false, reason: `a written file could not be read (${rel})` };
    let lowerVersion = 'absent';
    if (below) {
      changed(below, rel);
      if (below.isSymbolicLink()) { refused.push({ rel, reason: 'symbolic-link' }); continue; }
      if (below.isDirectory()) {
        // A lower directory replaced by a file: its whole tree goes first.
        const refusedTree = await removeTree(rel, 0, () => false);
        if (refusedTree) return { ok: false, reason: refusedTree };
        await removeDirectory(rel);
      } else if (below.isFile()) {
        const version = await sha256File(join(lower, rel));
        if (version === null) { refused.push({ rel, reason: 'not-a-regular-file' }); continue; }
        // A copy-up without a change (opened for writing, touched) is no change.
        if (version === digest && (Number(below.mode) & 0o777) === (entry.mode & 0o777)) { conflicts.delete(rel); continue; }
        lowerVersion = version;
      } else { refused.push({ rel, reason: 'special-file' }); continue; }
    }
    changes.push({ kind: 'write', rel, digest, size: entry.size, mode: entry.mode & 0o777, lowerVersion });
  }
  const tooMuch = over();
  if (tooMuch) return { ok: false, reason: tooMuch };
  // File removals first, then directory removals deepest first, then writes: a lower directory replaced by a file is emptied and removed
  // before the file is written.
  const order = (change: SandboxWriteChange) => change.kind === 'delete' ? 0 : change.kind === 'rmdir' ? 1 : 2;
  const depth = (change: SandboxWriteChange) => change.kind === 'rmdir' ? -change.rel.split('/').length : 0;
  return { ok: true, changes: [...changes].sort((a, b) => order(a) - order(b) || depth(a) - depth(b)), refused, conflicts: [...conflicts].sort(), emptyDirectories, directoryModes,
    newDirectories };
}

/** A call's private directory: `upper` and `work` for the overlay and the start mark (the directory's own ctime, the kernel clock). */
export interface SandboxWriteSetDirectory { readonly dir: string; readonly upper: string; readonly work: string; readonly mark: bigint }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
/** Removes a call directory (the kernel may leave `work/work` without permissions). */
export async function removeSandboxWriteSetDirectory(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(async () => {
    await chmod(join(dir, 'work', 'work'), 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
}
/**
 * Creates a call's directory under `root` (a private directory outside the project; never reused: `EEXIST` refuses) after removing the
 * directories whose service process is gone — a crash before their set was applied: nothing of them is ever applied late (design §3).
 */
export async function prepareSandboxWriteSetDirectory(root: string, callKey: string): Promise<SandboxWriteSetDirectory | null> {
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    const owner = await readFile(join(root, entry, 'owner.json'), 'utf8').then(text => Number(JSON.parse(text).pid)).catch(() => null);
    if (owner !== null && owner !== process.pid && !alive(owner)) await removeSandboxWriteSetDirectory(join(root, entry));
  }
  const dir = join(root, callKey);
  try {
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    await mkdir(join(dir, 'upper'), { mode: 0o700 }); await mkdir(join(dir, 'work'), { mode: 0o700 });
    return { dir, upper: join(dir, 'upper'), work: join(dir, 'work'), mark: (await lstat(dir, { bigint: true })).ctimeNs };
  } catch { return null; }
}

/**
 * Where a call's write-set directories may live (SHELL-OVERLAY design §0.1, §3): the project data root's `fileEffects`, then the global state
 * root's — the first private one whose real path neither holds nor sits inside the project (overlay layers may not nest). None → no write set.
 */
export async function sandboxWriteSetRoot(projectRoot: string, layout: ProductLayout, environment: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  const project = await realpath(projectRoot);
  const outside = (path: string) => { const down = relative(project, path), up = relative(path, project);
    return down !== '' && (down.startsWith('..') || isAbsolute(down)) && (up.startsWith('..') || isAbsolute(up)); };
  const candidates: (() => Promise<string>)[] = [
    async () => join(await prepareProductDirectory(layout, 'fileEffects'), 'sandbox-writes'),
    async () => {
      const global = resolveGlobalScopePaths(normalizeGlobalScopePlatform(process.platform, environment), environment).stateDir;
      return join(productResourcePath(resolveProductLayout({ projectRoot: global, root: global }), 'fileEffects'), 'sandbox-writes', createHash('sha256').update(project).digest('hex').slice(0, 16));
    },
  ];
  for (const candidate of candidates) {
    try {
      const path = await candidate();
      await mkdir(path, { recursive: true, mode: 0o700 });
      const real = await realpath(path), info = await stat(real);
      if (real === path && info.isDirectory() && (info.mode & 0o077) === 0 && info.uid === process.getuid!() && outside(real)) return real;
    } catch { /* the next candidate */ }
  }
  return null;
}
