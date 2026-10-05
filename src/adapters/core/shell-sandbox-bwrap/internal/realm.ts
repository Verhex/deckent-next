import { realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { ShellRealm, ShellRealmRequest, ShellRealmResult } from '#domain/index.js';
import { BASH_LAUNCH, describeShellWritePosture, fsOpsFor, gitWorktreeRepository, longLivedWritePosture, runShellProcess, sandboxWriteView, scanGitDirectory, type FsOps,
  type ShellCapabilities, type ShellSandbox, type ShellSandboxLayout, type ShellSandboxWriteView } from '#adapters/core/host-shell/index.js';
import { DECKENT_DIR } from '#platform/index.js';
import { BASELINE_IGNORED_DIRS } from '#adapters/core/workspace-read/index.js';
import { BUBBLEWRAP_ANCESTOR_PIN_MAX, BUBBLEWRAP_SYSTEM_PATHS, bubblewrapArguments, ancestorPins, type BubblewrapView } from './arguments.js';
import { BUBBLEWRAP_OVERLAY_VERSION, verifyBubblewrapLauncher } from './launcher.js';
/** The approval card's line for a bubblewrap run (merge Astra 2170 x MODES-3): the write part comes from the same view the sandbox
 * itself enforces (`describeShellWritePosture`), never a second copy of it. */
export const bubblewrapPosture = (view: ShellSandboxWriteView): string => view.open
  ? `Runs in an open bubblewrap sandbox (full access): network on, HOME visible, Deckent state and credentials hidden/read-only; ${describeShellWritePosture(view)}; `
    + 'the rest of the machine is reachable as your user, and every process it starts ends with the call.'
  : `Runs in a bubblewrap sandbox: ${describeShellWritePosture(view)}, the scratch area is writable, `
  + 'system directories and the PATH toolchain are read-only, HOME and everything else are hidden, there is no network, and every process it starts ends with the call.';
/** A long-lived server's line on its MCP cards (MCP-CLIENT, C5): the write part from the view its launch enforces, the rest as that view
 * is (a scratch area only when the layout binds one; the process ends with the service, not with a call). */
export const bubblewrapServerPosture = (view: ShellSandboxWriteView, scratch: boolean): string => `bubblewrap (${describeShellWritePosture(view)}; `
  + `${scratch ? 'the scratch area and a private /tmp are' : 'only a private /tmp is'} writable; HOME and everything else hidden, no network; it ends with the service)`;
/** Bounds of the deny walk over the project (ignored directories excluded): beyond them the sandbox refuses to run, never runs unmasked. */
export const BUBBLEWRAP_WALK_MAX_ENTRIES = 50_000;
/** Git metadata (`.git` trees, a worktree's common repository) is walked for the inode floor too, on its own budget (`objects/` is large). */
export const BUBBLEWRAP_GIT_WALK_MAX_ENTRIES = 200_000;
export const BUBBLEWRAP_MASK_MAX = 4_096;
const MAX_DEPTH = 32;
/** OPEN-SANDBOX: the HOME walk for credential-pattern files — HOME's entries to this depth (`~/a/b/c`), over this many entries the call is
 * refused (never run with HOME half-masked beyond what the bound says). Measured on the owner's HOME: 3.9 k entries at depth 3. */
export const BUBBLEWRAP_HOME_WALK_MAX_DEPTH = 3;
export const BUBBLEWRAP_HOME_WALK_MAX_ENTRIES = 20_000;
/** PATH entries under these prefixes are never bound: drives and mounts (WSL `/mnt/c`), sockets, devices, kernel views. */
const NEVER_BOUND_PREFIXES = ['/mnt', '/media', '/run', '/dev', '/proc', '/sys', '/var'];
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export interface BubblewrapOptions {
  readonly maxEntries?: number;
  /** The reads used per directory (default: synchronous on a local file system, asynchronous otherwise — `fsOpsFor`); tests inject one. */
  readonly fsOps?: (path: string) => FsOps;
}

/** Whether `a` and `b` (real paths) are the same or one holds the other: overlay layers may not (bubblewrap man page; undefined otherwise). */
const nested = (a: string, b: string) => { const up = relative(a, b), down = relative(b, a); return up === '' || !up.startsWith('..') && !isAbsolute(up) || !down.startsWith('..') && !isAbsolute(down); };

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
 * OPEN-SANDBOX: the installation's state roots as the open view seals them. Each is made its own real path; a root that does not exist yet
 * is created empty (0700) first — Deckent's own directory — because a mount over a missing path would create it on the host anyway, and a
 * missing root left open is exactly where a new name (live finding 3: `.deckent/mcp.json`) could appear. A root inside the project is
 * `sealed` (bound read-only; the deny walk masks its product state), one outside is `hidden` (an empty read-only tmpfs). A root that is,
 * holds or equals the project, HOME or `/` cannot be sealed without sealing them: the call is refused. Nested roots collapse into the outer.
 */
async function sealedRoots(project: string, roots: readonly string[], home: string | undefined): Promise<{ readonly ok: true; readonly sealed: string[]; readonly hidden: string[] }
  | { readonly ok: false; readonly reason: string }> {
  const real: string[] = [];
  for (const root of roots) {
    if (!isAbsolute(root)) return { ok: false, reason: `a Deckent state root is not absolute (${root})` };
    try { await mkdir(root, { recursive: true, mode: 0o700 }); real.push(await realpath(root)); }
    catch { return { ok: false, reason: `a Deckent state root could not be prepared (${root})` }; }
  }
  const holdsAll = [project, '/', ...(home && isAbsolute(home) ? [home] : [])];
  for (const root of real) if (holdsAll.some(path => under(path, root))) return { ok: false, reason: `the Deckent state root ${root} holds the project or HOME; the open view cannot seal it` };
  const outer = [...new Set(real)].filter((root, _, all) => !all.some(other => other !== root && under(root, other)));
  return { ok: true, sealed: outer.filter(root => under(root, project)), hidden: outer.filter(root => !under(root, project)) };
}
/**
 * OPEN-SANDBOX: masks the Core floor's credential-pattern files in HOME (`~/.npmrc`, `~/.ssh/id_*`, `**\/*.pem`, `**\/.credentials.json`, …)
 * over a bounded walk: HOME's entries to depth 3, generated/vendored trees (`BASELINE_IGNORED_DIRS`) and the skipped paths (the project,
 * which its own walk covers, and the state roots, sealed whole) not entered, symbolic links neither followed nor masked (as in the project),
 * an unreadable directory skipped (the command, the same user, cannot read it either). Over the entry bound the call is refused.
 */
async function maskHomeCredentials(home: string, denied: (rel: string) => boolean, skip: readonly string[], maskedDirectories: string[], maskedFiles: string[]): Promise<string | null> {
  let entries = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<string | null> => {
    let names;
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of names) {
      if (++entries > BUBBLEWRAP_HOME_WALK_MAX_ENTRIES) return `HOME credential walk over its bound (${BUBBLEWRAP_HOME_WALK_MAX_ENTRIES} entries)`;
      const path = join(dir, entry.name), entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink() || skip.some(root => under(path, root))) continue;
      if (denied(entryRel)) { if (entry.isDirectory()) maskedDirectories.push(path); else if (entry.isFile()) maskedFiles.push(path); continue; }
      if (!entry.isDirectory() || BASELINE_IGNORED_DIRS.has(entry.name) || depth + 1 >= BUBBLEWRAP_HOME_WALK_MAX_DEPTH) continue;
      const refused = await walk(path, entryRel, depth + 1);
      if (refused) return refused;
    }
    return null;
  };
  return walk(home, '', 0);
}

/**
 * Astra 2189 R7: whether every ancestor a view pins (`ancestorPins`) can be made a mount point — within the bound, and each a
 * canonical directory (`lstat` a directory, its own real path: a symbolic link in the chain would pin the link's target, not the name a
 * rename moves). Otherwise the view is refused; the command never runs with a renamable ancestor.
 */
async function canPinAncestors(view: BubblewrapView): Promise<string | null> {
  const pins = ancestorPins(view);
  if (pins.length > BUBBLEWRAP_ANCESTOR_PIN_MAX) return `protected-path ancestors over their bound (${BUBBLEWRAP_ANCESTOR_PIN_MAX})`;
  for (const path of pins) {
    try { if ((await lstat(path)).isDirectory() && await realpath(path) === path) continue; } catch { /* refused below */ }
    return `an ancestor of a protected path is not a canonical directory (${path})`;
  }
  return null;
}

type ListedEntries = readonly { readonly name: string; isSymbolicLink(): boolean; isDirectory(): boolean }[];
/**
 * SANDBOX-AD-SIZINTISI (top-20 #6): whether a directory holds the product's state and nothing of the project's own, so it can be one empty
 * read-only tmpfs instead of a row of per-entry masks: a `/dev/null` mask keeps the entry's name (`ledger.db`, `runtime.sock`, `backups`) listed,
 * and the names alone tell a command what the installation keeps. Every present entry must be denied (file or tree) or itself such a directory
 * (`state` beside denied siblings), a protected anchor must lie beneath, and no entry may be a symbolic link (a chain through one keeps its
 * refusal). One entry that is the project's own (an owner-Y `docs`, the readable configuration) keeps the per-entry masks. Never narrows a mask:
 * what was hidden still is, and nothing can be written there. The walk's entry budget is charged for every listing read here.
 */
async function holdsProductStateOnly(input: { readonly dir: string; readonly rel: string; readonly names: ListedEntries; readonly depth: number;
  readonly denied: (rel: string) => boolean; readonly protectedBeneath: (rel: string) => boolean; readonly list: (path: string) => ListedEntries | Promise<ListedEntries>;
  readonly count: (entries: number) => boolean }): Promise<boolean> {
  const { dir, rel, names, depth } = input;
  // The configured layout root (`DECKENT_DIR`) is never emptied whole: the project's own `docs` may not exist yet and a command must be able to create it (owner Y 2026-09-30);
  // its product-state subtrees (`data`, `state`) are emptied below it, and its own names stay listed.
  if (rel === '' || rel === DECKENT_DIR || names.length === 0 || depth > MAX_DEPTH || !input.protectedBeneath(rel)) return false;
  for (const entry of names) {
    if (entry.isSymbolicLink()) return false;
    const entryRel = `${rel}/${entry.name}`;
    if (input.denied(entryRel) || input.denied(`${entryRel}/`)) continue;
    if (!entry.isDirectory() || !input.protectedBeneath(entryRel)) return false;
    const path = join(dir, entry.name);
    let inner: ListedEntries;
    try { inner = await input.list(path); } catch { return false; }
    if (!input.count(inner.length) || !await holdsProductStateOnly({ ...input, dir: path, rel: entryRel, names: inner, depth: depth + 1 })) return false;
  }
  return true;
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
  options: Pick<BubblewrapOptions, 'maxEntries' | 'fsOps'> = {}, write: { readonly floorReadOnly?: boolean; readonly projectReadOnly?: boolean;
    readonly writeSet?: { readonly upper: string; readonly work: string }; readonly open?: boolean } = {}): Promise<{ readonly ok: true; readonly view: BubblewrapView } | { readonly ok: false; readonly reason: string }> {
  // SHELL-OVERLAY: the overlay's directories must be real, private, outside the project and not holding it (undefined overlay behavior).
  let overlay: { readonly upper: string; readonly work: string } | null = null;
  if (write.writeSet) {
    try {
      const upper = realpathSync(write.writeSet.upper), work = realpathSync(write.writeSet.work);
      if (upper !== write.writeSet.upper || work !== write.writeSet.work) return { ok: false, reason: 'the write set directories are not their own real paths' };
      if (nested(upper, layout.project.root) || nested(work, layout.project.root) || nested(upper, work)) return { ok: false, reason: 'the write set directories overlap the project' };
      if ([upper, work].some(path => { const info = statSync(path); return !info.isDirectory() || (info.mode & 0o077) !== 0; })) return { ok: false, reason: 'the write set directories are not private' };
      overlay = { upper, work };
    } catch { return { ok: false, reason: 'the write set directories could not be checked' }; }
  }
  const maxEntries = options.maxEntries ?? BUBBLEWRAP_WALK_MAX_ENTRIES, fsOps = options.fsOps ?? fsOpsFor;
  // OPEN-SANDBOX: the open view seals the hard floor structurally; asked of a layout that does not name it, it is refused (fail closed).
  const openView = write.open === true && !overlay && write.projectReadOnly !== true;
  if (write.open && !openView) return { ok: false, reason: 'the open view is only for a writable project' };
  const seal = openView ? layout.hardFloor ? await sealedRoots(layout.project.root, layout.hardFloor.roots, environment['HOME']) : { ok: false as const, reason: 'the hard floor is not known to this open view' } : null;
  if (seal && !seal.ok) return seal;
  // SHELL-AUTONOMY: for a call the owner did not approve, the write floor's existing files and trees are bound read-only (a mount point:
  // no write, rename or unlink lands); the deny masks inside them still follow. A floor path that does not exist yet is not covered here.
  // Fail closed (Astra 2170 R2): a read-only floor asked of a layout that does not know the floor is refused, never run with it writable.
  if (write.floorReadOnly && !layout.writeFloor) return { ok: false, reason: 'the write floor is not known to this sandbox view' };
  const floored = write.floorReadOnly && layout.writeFloor ? layout.writeFloor : () => false;
  const root = layout.project.root;
  const openFloor = seal?.ok && !write.floorReadOnly && layout.writeFloor ? (rel: string) => seal.sealed.some(sealed => under(join(root, rel), sealed)) && layout.writeFloor!(rel) : () => false;
  const readOnly = new Set<string>(), writable = new Set<string>(), maskedDirectories: string[] = [], maskedFiles: string[] = [], emptied: string[] = [];
  let entries = 0, gitEntries = 0;
  const overMasks = () => maskedDirectories.length + maskedFiles.length + emptied.length > BUBBLEWRAP_MASK_MAX ? `deny masks over their bound (${BUBBLEWRAP_MASK_MAX})` : null;
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
  // MODES-3: a full-access turn binds no Git metadata read-only (the project bind is writable; a worktree's common repository is bound
  // writable) — the inode floor's masks still apply.
  // A read-only project keeps its repository read-only too (merge Astra 2170 x MODES-3): no writable common repository under a `--ro-bind`.
  // The same fact the card's text reads (`sandboxWriteView`).
  const { repositoryWritable } = sandboxWriteView(layout, { writeFloorReadOnly: write.floorReadOnly === true, projectReadOnly: write.projectReadOnly === true, writeSet: overlay !== null });
  const gitReadOnly = (path: string) => { if (repositoryWritable) writable.add(path); else readOnly.add(path); };
  const gitEntry = async (path: string, rel: string, isDirectory: boolean, isFile: boolean): Promise<string | null> => {
    if (isDirectory) { if (!repositoryWritable) readOnly.add(path); return walkGit(path, 0); }
    if (!isFile) return null;
    if (await fsOps(path).nlink(path) > 1) { maskedFiles.push(path); return null; }
    if (rel !== '') return null;
    if (!repositoryWritable) readOnly.add(path);
    const common = await gitWorktreeRepository(root);
    if (!common) return null;
    gitReadOnly(common);
    return walkGit(common, 0);
  };
  // Astra 2162: the product's own state and its ancestors stay protected under an ignored tree. An ignored directory that holds a
  // protected path is not skipped whole: it is listed, its denied entries masked, and only the ancestors of protected paths are entered
  // (siblings stay unscanned, as ignored). A symbolic link on such a chain cannot be masked by path → the call is refused.
  const anchors = [...layout.project.protectedAnchors];
  const onChain = (rel: string) => anchors.some(path => path === rel || path.startsWith(`${rel}/`));
  const hasProtectedBeneath = (rel: string) => anchors.some(path => path.startsWith(`${rel}/`));
  const stateOnly = (dir: string, rel: string, names: ListedEntries, depth: number) => holdsProductStateOnly({ dir, rel, names, depth, denied: layout.project.denied,
    protectedBeneath: hasProtectedBeneath, list: path => fsOps(path).readdir(path), count: n => (entries += n) <= maxEntries });
  const walkProtected = async (dir: string, rel: string, depth: number): Promise<string | null> => {
    let names;
    try { names = await fsOps(dir).readdir(dir); } catch { maskedDirectories.push(dir); return null; }
    if (await stateOnly(dir, rel, names, depth)) { entries += names.length; if (entries > maxEntries) return `deny walk over its bound (${maxEntries} entries)`; emptied.push(dir); return overMasks(); }
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
    if (await stateOnly(dir, rel, names, depth)) { entries += names.length; if (entries > maxEntries) return `deny walk over its bound (${maxEntries} entries)`; emptied.push(dir); return overMasks(); }
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
      if (entry.isFile()) {
        if ((links.get(entry.name) ?? 2) > 1) maskedFiles.push(path);
        else if (floored(entryRel)) readOnly.add(path);
        // OPEN-SANDBOX: the owner's card approved the write floor (an owner-approved call of a full-access turn: the configuration file); a
        // sealed state root keeps every other name read-only, so the existing floor file alone is bound writable (content, never a new name).
        else if (openFloor(entryRel)) writable.add(path);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (layout.project.denied(`${entryRel}/`)) { maskedDirectories.push(path); continue; }
      if (floored(`${entryRel}/-`)) readOnly.add(path);
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
  if (seal?.ok) {
    // Owner Y (2026-09-30): an existing subdirectory of a sealed root that is not Deckent's state (a tracked `.deckent/docs`) is the project's —
    // bound writable over the read-only root (the deny masks inside it still follow); the root's own names stay read-only, none can be added.
    const product = layout.hardFloor?.product;
    for (const sealed of product ? seal.sealed : []) {
      let names;
      try { names = await readdir(sealed, { withFileTypes: true }); } catch { continue; }
      for (const entry of names) {
        const path = join(sealed, entry.name), rel = relative(root, path);
        if (entry.isDirectory() && !entry.isSymbolicLink() && !product!(rel) && !layout.project.denied(rel) && !layout.project.denied(`${rel}/`) && !onChain(rel)) writable.add(path);
      }
    }
    // OPEN-SANDBOX: HOME is the host's; the Core floor's credential patterns are masked in it (bounded walk), the state roots skipped. The
    // walk starts at HOME's real path, so every mask (and each ancestor pinned for it, R7) is canonical.
    const realHome = homeDir ? await realpath(homeDir).catch(() => homeDir) : null;
    const refusedHome = realHome && layout.hardFloor ? await maskHomeCredentials(realHome, layout.hardFloor.homeDenied, [root, ...seal.sealed, ...seal.hidden], maskedDirectories, maskedFiles) : null;
    if (refusedHome) return { ok: false, reason: refusedHome };
    const over = overMasks(); if (over) return { ok: false, reason: over };
    const view: BubblewrapView = Object.freeze({ projectRoot: root, open: { sealed: seal.sealed, hidden: seal.hidden }, scratchDir, home: homeDir, systemPaths: [], toolchainPaths: [],
      readOnlyPaths: [...readOnly], ...(writable.size ? { writablePaths: [...writable] } : {}), maskedDirectories, maskedFiles, ...(emptied.length ? { emptiedDirectories: emptied } : {}) });
    const refusedPins = await canPinAncestors(view);
    return refusedPins ? { ok: false, reason: refusedPins } : { ok: true, view };
  }
  const toolchainPaths = await toolchainOf(environment['PATH'], { enclosed: [root, ...(scratchDir ? [scratchDir] : [])], home: homeDir });
  const view: BubblewrapView = Object.freeze({ projectRoot: root, ...(overlay ? { overlay } : write.projectReadOnly ? { projectReadOnly: true } : {}), scratchDir, home: homeDir,
    systemPaths: BUBBLEWRAP_SYSTEM_PATHS, toolchainPaths, readOnlyPaths: [...readOnly], ...(writable.size ? { writablePaths: [...writable] } : {}), maskedDirectories, maskedFiles, ...(emptied.length ? { emptiedDirectories: emptied } : {}) });
  // R7 follow-up: a closed view with a writable project pins the in-project ancestors of its masks and read-only paths too.
  const refusedPins = await canPinAncestors(view);
  return refusedPins ? { ok: false, reason: refusedPins } : { ok: true, view };
}

/**
 * The bubblewrap realm (S9): the same process runner as the host shell (process group, cancellation, timeout, bounded output,
 * cleanup) launching `bwrap … -- bash --noprofile --norc -c <command>`. Usable only when the host measurement selected a launcher whose
 * own sandbox run succeeded (BWRAP-SELECT) and that file is still the measured one; otherwise it says why and the resolver decides.
 */
export function bubblewrapShellSandbox(layout: ShellSandboxLayout, options: BubblewrapOptions = {}): ShellSandbox {
  const run = (bwrap: string, writeSets: boolean): ShellRealm => Object.freeze({ kind: 'bubblewrap', async run(request: ShellRealmRequest): Promise<ShellRealmResult> {
    const started = performance.now();
    const view = request.writeSet && !writeSets ? { ok: false as const, reason: `bwrap at ${bwrap} has no overlay (bubblewrap ${BUBBLEWRAP_OVERLAY_VERSION} or later is needed)` }
      : await resolveBubblewrapView(layout, request.environment ?? process.env, options,
        { floorReadOnly: request.writeFloorReadOnly === true, projectReadOnly: request.projectReadOnly === true, ...(request.writeSet ? { writeSet: request.writeSet } : {}),
          ...(request.open ? { open: true } : {}) });
    if (!view.ok) {
      return Object.freeze({ status: 'spawn-failed', exitCode: null, signal: null, output: `[deckent] sandbox: ${view.reason}; nothing was run.`, totalBytes: 0, omittedBytes: 0,
        durationMs: Math.round(performance.now() - started), cleanup: 'clean' });
    }
    const prefix = bubblewrapArguments(view.view);
    return runShellProcess({ file: bwrap, args: command => [...prefix, '--', BASH_LAUNCH.file, ...BASH_LAUNCH.args(command)] }, request);
  } });
  return Object.freeze({ kind: 'bubblewrap',
    usable(capabilities: ShellCapabilities): ReturnType<ShellSandbox['usable']> {
      const { status, launcher, detail } = capabilities.bubblewrap;
      if (status === 'restricted') return { ok: false, restricted: true, reason: detail ?? 'user namespace restricted' };
      if (status !== 'available' || !launcher) return { ok: false, reason: `bubblewrap ${status}${detail ? ` (${detail})` : ''}` };
      // A launcher a sandboxed command could replace (a state root set inside the project or scratch area) is never run outside it.
      if ([layout.project.root, ...(layout.scratchDir ? [layout.scratchDir] : [])].some(root => under(launcher.path, root))) {
        return { ok: false, reason: `bwrap at ${launcher.path} is inside the project or scratch area, where a sandboxed command could replace it` };
      }
      const verified = verifyBubblewrapLauncher(launcher);
      if (!verified.ok) return { ok: false, reason: verified.reason };
      const binary = launcher;
      // MCP-CLIENT: the same view for a long-lived server process (`bwrap <view> -- <command>`), resolved when it starts. A server is
      // third-party code no card approves call by call: its view is the unattended posture with the whole project read-only (C5, owner
      // 2026-09-29, until SHELL-OVERLAY; `longLivedWritePosture`), the write floor's matcher still required (fail closed).
      const launch = async (environment: Readonly<Record<string, string | undefined>>) => {
        const write = sandboxWriteView(layout, longLivedWritePosture());
        const view = await resolveBubblewrapView(layout, environment, options, { floorReadOnly: write.writeFloorReadOnly, projectReadOnly: write.projectReadOnly });
        return view.ok ? { ok: true as const, file: binary.path, args: bubblewrapArguments(view.view), view: write, posture: bubblewrapServerPosture(write, layout.scratchDir !== null) }
          : { ok: false as const, reason: view.reason };
      };
      // SHELL-OVERLAY × BWRAP-SELECT: write sets are offered exactly when the selected launcher's measured version has the overlay options
      // (`launcher.overlay`, ≥ 0.11.0: the bundled 0.13 always, a system ≥ 0.12 too); otherwise a write-set request is refused (nothing runs).
      const writeSets = binary.overlay;
      // OPEN-SANDBOX: every selected launcher builds the full-access open view (its options exist since long before 0.12).
      return { ok: true, realm: run(binary.path, writeSets), marker: 'sandbox: bubblewrap', posture: bubblewrapPosture, notice: null, containment: 'sandbox', launch,
        ...(writeSets ? { writeSets: true } : {}), opens: true };
    } });
}
