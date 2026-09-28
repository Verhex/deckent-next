import { statSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { ShellRealm, ShellRealmRequest, ShellRealmResult } from '#domain/index.js';
import { BASH_LAUNCH, fsOpsFor, gitWorktreeRepository, runShellProcess, scanGitDirectory, type FsOps, type ShellCapabilities, type ShellSandbox, type ShellSandboxLayout } from '#adapters/core/host-shell/index.js';
import { BASELINE_IGNORED_DIRS } from '#adapters/core/workspace-read/index.js';
import { BUBBLEWRAP_SYSTEM_PATHS, bubblewrapArguments, type BubblewrapView } from './arguments.js';

/** Where a distribution installs bubblewrap; PATH is never consulted for the launcher (a PATH entry is data the command sees). */
export const BUBBLEWRAP_KNOWN_PATHS: readonly string[] = Object.freeze(['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap']);
export const BUBBLEWRAP_POSTURE = 'Runs in a bubblewrap sandbox: the project is writable (.git read-only), the scratch area is writable, system directories '
  + 'and the PATH toolchain are read-only, HOME and everything else are hidden, there is no network, and every process it starts ends with the call.';
/** Bounds of the deny walk over the project (ignored directories excluded): beyond them the sandbox refuses to run, never runs unmasked. */
export const BUBBLEWRAP_WALK_MAX_ENTRIES = 50_000;
/** Git metadata (`.git` trees, a worktree's common repository) is walked for the inode floor too, on its own budget (`objects/` is large). */
export const BUBBLEWRAP_GIT_WALK_MAX_ENTRIES = 200_000;
export const BUBBLEWRAP_MASK_MAX = 4_096;
const MAX_DEPTH = 32;
/** PATH entries under these prefixes are never bound: drives and mounts (WSL `/mnt/c`), sockets, devices, kernel views. */
const NEVER_BOUND_PREFIXES = ['/mnt', '/media', '/run', '/dev', '/proc', '/sys', '/var'];
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export interface BubblewrapOptions {
  /** Where the launcher may be (tests point at a fixture); each must be a regular, executable file not writable by group or others. */
  readonly binaryPaths?: readonly string[];
  readonly maxEntries?: number;
  /** The reads used per directory (default: synchronous on a local file system, asynchronous otherwise — `fsOpsFor`); tests inject one. */
  readonly fsOps?: (path: string) => FsOps;
}

/** The verified launcher: the first known path holding a regular executable that only its owner can change. */
function findBubblewrap(paths: readonly string[]): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string } {
  for (const path of paths) {
    try {
      const info = statSync(path);
      if (!info.isFile()) continue;
      if ((info.mode & 0o111) === 0) return { ok: false, reason: `bwrap at ${path} is not executable` };
      if ((info.mode & 0o022) !== 0) return { ok: false, reason: `bwrap at ${path} is writable by group or others` };
      return { ok: true, path };
    } catch { /* not here */ }
  }
  return { ok: false, reason: `bwrap not found at a known path (${paths.join(', ')})` };
}

/** PATH entries bound read-only are program directories only: `bin`, `.bin` or `sbin` by name (a `bin` brings its `lib*`/`libexec` siblings). */
const TOOLCHAIN_DIR_NAMES = new Set(['bin', '.bin', 'sbin']);
/**
 * PATH directories outside the system prefixes that exist (a toolchain under HOME such as nvm), read-only. Never HOME itself, an
 * ancestor of it (`/home`, `/root`, `/`), the project, the scratch area or any ancestor of those; never a directory that is not a
 * program directory by name (`~/.local` would expose `~/.local/share`). Every bind source — the entry and each sibling — is its own
 * canonical directory (no symbolic link in any component: `realpath(path) === path`, `lstat` a directory) checked against the same
 * exclusions (Astra 2154 R1): `lib -> $HOME` beside a `bin` is not a bind. A symbolic-link toolchain directory is therefore not bound
 * at all. bubblewrap opens the canonical path at mount time; a component swapped for a link between this check and the mount is the
 * documented same-user race (as for scratch), not a path this rule opens.
 */
async function toolchainOf(pathVariable: string | undefined, protectedPaths: { readonly enclosed: readonly string[]; readonly home: string | null }): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  // Skipped: excluded/system prefixes; not a program directory by name; inside or above the project/scratch area; HOME itself or above it
  // (a directory under HOME — nvm, `~/.local/bin` — is what this is for).
  const excluded = (path: string) => NEVER_BOUND_PREFIXES.some(prefix => under(path, prefix)) || BUBBLEWRAP_SYSTEM_PATHS.some(prefix => under(path, prefix))
    || protectedPaths.enclosed.some(enclosed => under(path, enclosed) || under(enclosed, path)) || (protectedPaths.home !== null && under(protectedPaths.home, path));
  const skipped = (path: string) => excluded(path) || !TOOLCHAIN_DIR_NAMES.has(basename(path));
  /** Whether the path is a canonical directory (no link in any component) that the exclusions admit (the name rule is the entry's alone). */
  const canonicalDirectory = async (path: string): Promise<boolean> => {
    try { if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) return false; } catch { return false; }
    return !excluded(path);
  };
  for (const entry of (pathVariable ?? '').split(':').slice(0, 256)) {
    // Excluded prefixes are decided on the text first: a foreign drive (`/mnt/c/…` on WSL) is never touched (each stat there costs milliseconds).
    if (!isAbsolute(entry) || skipped(entry)) continue;
    let real: string;
    try { real = await realpath(entry); } catch { continue; }
    if (skipped(real) || !await canonicalDirectory(real)) continue;
    const candidates = basename(real) === 'bin' ? [real, ...['lib', 'lib64', 'libexec'].map(name => join(dirname(real), name))] : [real];
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      if (!await canonicalDirectory(candidate)) continue;
      seen.add(candidate); out.push(candidate);
    }
  }
  return out;
}

/**
 * Resolves the sandbox's view for a layout: the deny floor is enumerated from the project root (no symlink is followed or masked;
 * `BASELINE`-ignored directories such as `node_modules` and `dist` are not entered), every `.git` becomes read-only, HOME comes
 * from the command's environment. What the walk could not see is closed, never left read-write (Astra 2154 R3): a directory it
 * could not read, or one beyond the depth bound, is masked as an empty tmpfs; a regular file with more than one link is masked like
 * a denied file, because another name of a protected inode would otherwise open it (Astra 2154 R2; the read tools refuse such files
 * too). Over the entry/mask bounds the view is refused (the command will not run), never left unmasked.
 */
export async function resolveBubblewrapView(layout: ShellSandboxLayout, environment: Readonly<Record<string, string | undefined>>,
  options: Pick<BubblewrapOptions, 'maxEntries' | 'fsOps'> = {}): Promise<{ readonly ok: true; readonly view: BubblewrapView } | { readonly ok: false; readonly reason: string }> {
  const maxEntries = options.maxEntries ?? BUBBLEWRAP_WALK_MAX_ENTRIES, fsOps = options.fsOps ?? fsOpsFor;
  const root = layout.project.root;
  const readOnly = new Set<string>(), maskedDirectories: string[] = [], maskedFiles: string[] = [];
  let entries = 0, gitEntries = 0;
  const overMasks = () => maskedDirectories.length + maskedFiles.length > BUBBLEWRAP_MASK_MAX ? `deny masks over their bound (${BUBBLEWRAP_MASK_MAX})` : null;
  /**
   * The inode floor over Git metadata (Astra 2156): a `.git` tree or a worktree's common repository is bound read-only, but read-only
   * does not hide another name of a protected inode, so every regular file with more than one link inside it is masked, an unreadable
   * or too deep directory is masked, and a symbolic link takes nothing. Only this floor applies inside (the deny floor names `.git/**`
   * as a whole). A hard-linked local clone's shared objects stay readable when their content verifies against their name; any other
   * multi-linked file is closed (`scanGitDirectory`: verdicts re-read every call, only object hashes cached — Astra 2158).
   */
  const walkGit = async (dir: string, depth: number): Promise<string | null> => {
    const scan = await scanGitDirectory(dir, fsOps(dir));
    if (!scan.readable) { maskedDirectories.push(dir); return null; }
    if ((gitEntries += scan.suspectFiles.length + scan.cleanFiles.length + scan.directories.length) > BUBBLEWRAP_GIT_WALK_MAX_ENTRIES) {
      return `git metadata walk over its bound (${BUBBLEWRAP_GIT_WALK_MAX_ENTRIES} entries)`;
    }
    for (const name of scan.suspectFiles) { const over = overMasks(); if (over) return over; maskedFiles.push(join(dir, name)); }
    for (const name of scan.directories) {
      const over = overMasks(); if (over) return over;
      if (depth + 1 > MAX_DEPTH) { maskedDirectories.push(join(dir, name)); continue; }
      const refused = await walkGit(join(dir, name), depth + 1);
      if (refused) return refused;
    }
    return null;
  };
  /** A `.git` entry: the inode floor first (a multi-linked `.git` file is another name of something and is masked, never a grant), then the
   * read-only grant: a directory anywhere; the root file (a worktree) itself and, in the verified worktree shape, its common repository. */
  const gitEntry = async (path: string, rel: string, isDirectory: boolean, isFile: boolean): Promise<string | null> => {
    if (isDirectory) { readOnly.add(path); return walkGit(path, 0); }
    if (!isFile) return null;
    if (await fsOps(path).nlink(path) > 1) { maskedFiles.push(path); return null; }
    if (rel !== '') return null;
    readOnly.add(path);
    const common = await gitWorktreeRepository(root);
    if (!common) return null;
    readOnly.add(common);
    return walkGit(common, 0);
  };
  // Astra 2162: the product's own state and its ancestors stay protected under an ignored tree. An ignored directory that holds a
  // protected path is not skipped whole: it is listed, its denied entries masked, and only the ancestors of protected paths are entered
  // (siblings stay unscanned, as ignored). A symbolic link on such a chain cannot be masked by path → the call is refused.
  const anchors = [...layout.project.protectedAnchors];
  const onChain = (rel: string) => anchors.some(path => path === rel || path.startsWith(`${rel}/`));
  const hasProtectedBeneath = (rel: string) => anchors.some(path => path.startsWith(`${rel}/`));
  const walkProtected = async (dir: string, rel: string, depth: number): Promise<string | null> => {
    let names;
    try { names = await fsOps(dir).readdir(dir); } catch { maskedDirectories.push(dir); return null; }
    for (const entry of names) {
      if (++entries > maxEntries) return `deny walk over its bound (${maxEntries} entries)`;
      const over = overMasks(); if (over) return over;
      const path = join(dir, entry.name), entryRel = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) { if (onChain(entryRel)) return `protected product state behind a symbolic link (${entryRel})`; continue; }
      if (layout.project.denied(entryRel)) { (entry.isDirectory() ? maskedDirectories : maskedFiles).push(path); continue; }
      if (!entry.isDirectory() || !hasProtectedBeneath(entryRel)) continue;
      if (depth + 1 > MAX_DEPTH) { maskedDirectories.push(path); continue; }
      const refused = await walkProtected(path, entryRel, depth + 1);
      if (refused) return refused;
    }
    return null;
  };
  const walk = async (dir: string, rel: string, depth: number): Promise<string | null> => {
    let names;
    const ops = fsOps(dir);
    try { names = await ops.readdir(dir); }
    catch { if (rel === '') return 'the project root could not be read'; maskedDirectories.push(dir); return null; }
    // Link counts of this directory's regular files (a failed read masks): read synchronously on a local file system, concurrently
    // through the thread pool otherwise.
    const links = new Map(await Promise.all(names.filter(entry => entry.isFile()).map(async entry =>
      [entry.name, await ops.nlink(join(dir, entry.name))] as const)));
    for (const entry of names) {
      if (++entries > maxEntries) return `deny walk over its bound (${maxEntries} entries)`;
      const over = overMasks(); if (over) return over;
      const path = join(dir, entry.name), entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) { if (onChain(entryRel)) return `protected product state behind a symbolic link (${entryRel})`; continue; }
      // `.git`: see `gitEntry` — the inode floor, then the read-only grant (a nested `.git` file, a pointer the sandboxed command could have
      // written, opens nothing: a submodule loses `git status` inside; documented).
      if (entry.name === '.git') { const refused = await gitEntry(path, rel, entry.isDirectory(), entry.isFile()); if (refused) return refused; continue; }
      if (layout.project.denied(entryRel)) { (entry.isDirectory() ? maskedDirectories : maskedFiles).push(path); continue; }
      // Another name of a protected inode (a hard link) is closed with the inode; a regular single-link file stays open.
      if (entry.isFile()) { if ((links.get(entry.name) ?? 2) > 1) maskedFiles.push(path); continue; }
      if (!entry.isDirectory()) continue;
      if (layout.project.denied(`${entryRel}/`)) { maskedDirectories.push(path); continue; }
      // Generated/vendored trees are not entered (their content is not secret-bearing by the floor's definition and can be huge); a
      // directory ignored only by the project's .gitignore (e.g. `.brain/`) is, so `.brain/memory.db*` is masked.
      if (BASELINE_IGNORED_DIRS.has(entry.name)) {
        if (hasProtectedBeneath(entryRel)) { const refused = await walkProtected(path, entryRel, depth + 1); if (refused) return refused; }
        continue;
      }
      // Beyond the depth bound nothing is seen, so nothing is opened.
      if (depth + 1 > MAX_DEPTH) { maskedDirectories.push(path); continue; }
      const refused = await walk(path, entryRel, depth + 1);
      if (refused) return refused;
    }
    return null;
  };
  const refused = await walk(root, '', 0);
  if (refused) return { ok: false, reason: refused };
  const home = environment['HOME'];
  const scratchDir = layout.scratchDir;
  const homeDir = home && isAbsolute(home) ? home : null;
  const toolchainPaths = await toolchainOf(environment['PATH'], { enclosed: [root, ...(scratchDir ? [scratchDir] : [])], home: homeDir });
  return { ok: true, view: Object.freeze({ projectRoot: root, scratchDir, home: homeDir, systemPaths: BUBBLEWRAP_SYSTEM_PATHS,
    toolchainPaths, readOnlyPaths: [...readOnly], maskedDirectories, maskedFiles }) };
}

/**
 * The bubblewrap realm (S9): the same process runner as the host shell (process group, cancellation, timeout, bounded output,
 * cleanup) launching `bwrap … -- bash --noprofile --norc -c <command>`. Usable only when the host measurement found the binary
 * and a working user namespace and the launcher is verified at a known path; otherwise it says why and the resolver decides.
 */
export function bubblewrapShellSandbox(layout: ShellSandboxLayout, options: BubblewrapOptions = {}): ShellSandbox {
  const run = (bwrap: string): ShellRealm => Object.freeze({ kind: 'bubblewrap', async run(request: ShellRealmRequest): Promise<ShellRealmResult> {
    const started = performance.now();
    const view = await resolveBubblewrapView(layout, request.environment ?? process.env, options);
    if (!view.ok) {
      return Object.freeze({ status: 'spawn-failed', exitCode: null, signal: null, output: `[deckent] sandbox: ${view.reason}; nothing was run.`, totalBytes: 0, omittedBytes: 0,
        durationMs: Math.round(performance.now() - started), cleanup: 'clean' });
    }
    const prefix = bubblewrapArguments(view.view);
    return runShellProcess({ file: bwrap, args: command => [...prefix, '--', BASH_LAUNCH.file, ...BASH_LAUNCH.args(command)] }, request);
  } });
  return Object.freeze({ kind: 'bubblewrap',
    usable(capabilities: ShellCapabilities): ReturnType<ShellSandbox['usable']> {
      if (capabilities.bubblewrap !== 'available') return { ok: false, reason: `bubblewrap ${capabilities.bubblewrap}` };
      if (capabilities.userNamespace !== 'available') return { ok: false, reason: `user namespace ${capabilities.userNamespace}` };
      const binary = findBubblewrap(options.binaryPaths ?? BUBBLEWRAP_KNOWN_PATHS);
      return binary.ok ? { ok: true, realm: run(binary.path), marker: 'sandbox: bubblewrap', posture: BUBBLEWRAP_POSTURE, notice: null } : { ok: false, reason: binary.reason };
    } });
}
