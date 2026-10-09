import type { Dirent } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShellRealm, ShellRealmRequest, ShellRealmResult } from '#domain/index.js';
import type { ShellCapabilities } from './probe.js';
import type { ShellSandbox, ShellSandboxLayout, ShellSandboxWriteView } from './realm.js';
import { describeShellWritePosture, sandboxHardFloored, sandboxWriteView } from './realm.js';
import { BASH_LAUNCH, runShellProcess } from './run.js';
import { scanGitDirectory } from './git-objects.js';
import { fsOpsFor, type FsOps } from './fs-ops.js';

/** Rule classes the native helper maps to Landlock rights: `x` read + execute, `r` read, `w` read-write (no device nodes),
 * `l` list the directory only, `d` a device file (read/write). */
export type LandlockRuleClass = 'x' | 'r' | 'w' | 'l' | 'd';
export type LandlockRule = readonly [LandlockRuleClass, string];
export const LANDLOCK_RULE_BOUNDS = Object.freeze({ maxEntries: 20_000, maxGitEntries: 200_000, maxDepth: 32, maxRules: 8_192, maxBytes: 1_048_576 });
export type LandlockRuleSet = { readonly ok: true; readonly rules: readonly LandlockRule[] } | { readonly ok: false; readonly reason: string };

const HELPER = fileURLToPath(new URL('../native/build/Release/shell-sandbox', import.meta.url));
const SYSTEM_EXEC = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/opt'];
const SYSTEM_READ = ['/etc', '/proc'];
const DEVICES = ['/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom'];

class BoundExceeded extends Error {}
const exists = async (path: string, kind: 'dir' | 'any') => { try { const info = await stat(path); return kind === 'any' || info.isDirectory(); } catch { return false; } };

/** A git worktree's `.git` file (at the project root only) opens its repository read-only, and only when it has the worktree shape:
 * `gitdir: <common>/worktrees/<name>` whose `commondir` names `<common>` again (the gitdir lies inside it). Any other `.git` file — a
 * pointer a sandboxed command could write — opens nothing outside. Shared by the Landlock and bubblewrap realms. */
export async function gitWorktreeRepository(root: string): Promise<string | null> {
  try {
    const text = (await readFile(join(root, '.git'), 'utf8')).slice(0, 4_096);
    const match = /^gitdir: (.+)$/mu.exec(text);
    if (!match) return null;
    const gitdir = await realpath(resolve(root, match[1]!.trim()));
    const common = await realpath(resolve(gitdir, (await readFile(join(gitdir, 'commondir'), 'utf8')).trim()));
    return basename(dirname(gitdir)) === 'worktrees' && dirname(dirname(gitdir)) === common ? common : null;
  } catch { return null; }
}

/**
 * The Landlock rule set of one shell call (S11), from a fresh scan of the project. Landlock only adds access and a rule on a
 * directory reaches everything beneath it, so a directory with a protected path or a `.git` below it cannot take a read-write rule:
 * it is carved — listing only — and its entries take rules one by one: clean files and clean trees read-write, `.git` read-only,
 * protected paths (the scope's deny list), multiply linked files, special files and unreadable directories no rule at all.
 * Symbolic links take no rule (access through one resolves to its target's own rule). Ignored directories (node_modules, dist, …)
 * are not scanned and are read-write as a whole. Past a bound the set is refused, never cut.
 */
export async function buildLandlockRules(input: ShellSandboxLayout, bounds: Partial<typeof LANDLOCK_RULE_BOUNDS> = {},
  fsOps: (path: string) => FsOps = fsOpsFor, write: { readonly floorReadOnly?: boolean; readonly projectReadOnly?: boolean } = {}): Promise<LandlockRuleSet> {
  const limit = { ...LANDLOCK_RULE_BOUNDS, ...bounds }, { root, denied, ignoredDirs } = input.project;
  // SHELL-AUTONOMY: for a call the owner did not approve, the write floor's existing files and trees take read-only rules (their
  // directory is carved, so the entry cannot be replaced or removed either). A floor path that does not exist yet is not covered here.
  // Fail closed (Astra 2170 R2): a read-only floor asked of a layout that does not know the floor is refused, never run with it writable.
  if (write.floorReadOnly && !input.writeFloor) return { ok: false, reason: 'the write floor is not known to this sandbox view' };
  const floored = (rel: string) => sandboxHardFloored(input, rel) || (write.floorReadOnly === true && input.writeFloor?.(rel) === true);
  // Astra 2170 R1: an unbounded unattended call sees the whole project read-only (only the scratch area stays writable).
  const projectClass: 'w' | 'r' = write.projectReadOnly ? 'r' : 'w';
  // MODES-3: a full-access turn writes Git metadata (commit, branch): its clean entries take `w` rules; the inode floor is unchanged.
  // A read-only project keeps its repository read-only too (merge Astra 2170 x MODES-3); the card's text reads the same fact.
  const git = sandboxWriteView(input, { writeFloorReadOnly: write.floorReadOnly === true, projectReadOnly: write.projectReadOnly === true }).repositoryWritable ? 'w' as const : 'r' as const;
  let seen = 0;
  let gitSeen = 0;
  /**
   * Git metadata (a `.git` tree, a worktree's common repository) read-only under the inode floor (Astra 2156): a directory whose subtree
   * holds only single-link regular files and readable directories takes one `r` rule; otherwise it is carved (listing only) and its
   * entries take rules one by one — a multi-linked file, a symbolic link, a special file, an unreadable or too deep directory none.
   * `rulePath` is relative under the root (opened beneath it) or absolute for the common repository. A hard-linked local clone's shared
   * objects stay readable when their content verifies against their name; any other multi-linked file is closed (`scanGitDirectory`).
   */
  const scanGit = async (dir: string, rulePath: string, depth: number): Promise<readonly LandlockRule[]> => {
    const scanned = await scanGitDirectory(dir, fsOps(dir));
    if (!scanned.readable) return [];
    if ((gitSeen += scanned.suspectFiles.length + scanned.cleanFiles.length + scanned.directories.length) > limit.maxGitEntries) {
      throw new BoundExceeded(`the git metadata has more than ${limit.maxGitEntries} entries to scan`);
    }
    if (depth + 1 > limit.maxDepth) return [['l', rulePath]];
    const inner = await Promise.all(scanned.directories.map(async name => {
      const childRule = `${rulePath}/${name}`, rules = await scanGit(join(dir, name), childRule, depth + 1);
      return rules.length === 1 && rules[0]![0] === git && rules[0]![1] === childRule ? { clean: childRule } : { rules };
    }));
    // Every entry clean (a single-link or verified file, a clean directory) → the directory itself is one read-only rule.
    if (scanned.suspectFiles.length === 0 && inner.every(verdict => verdict.clean !== undefined)) return [[git, rulePath]];
    return [['l', rulePath], ...scanned.cleanFiles.map(name => [git, `${rulePath}/${name}`] as const), ...inner.flatMap(verdict => verdict.clean ? [[git, verdict.clean] as const] : verdict.rules ?? [])];
  };
  // Astra 2162: the product's own state and its ancestors stay protected under an ignored tree. An ignored directory that holds a
  // protected path is not one read-write grant: it is carved — listing only, its denied entries take no rule, the ancestors of protected
  // paths are carved in turn, every other entry keeps its read-write grant unscanned (as ignored). A symbolic link on such a chain
  // cannot be carved by path → the set is refused.
  const anchors = [...input.project.protectedAnchors, '.deckent', ...(input.hardFloor?.roots ?? []).map(path => relative(root, path)).filter(path => path && !path.startsWith('..') && !isAbsolute(path))];
  const onChain = (rel: string) => anchors.some(path => path === rel || path.startsWith(`${rel}/`));
  const hasProtectedBeneath = (rel: string) => anchors.some(path => path.startsWith(`${rel}/`));
  const carveProtected = async (rel: string, depth: number, cls: 'w' | 'r'): Promise<readonly LandlockRule[]> => {
    let entries: Dirent[];
    const path = join(root, rel);
    try { entries = await fsOps(path).readdir(path); } catch { return []; }
    if ((seen += entries.length) > limit.maxEntries) throw new BoundExceeded(`the project has more than ${limit.maxEntries} entries to scan`);
    if (depth + 1 > limit.maxDepth) throw new BoundExceeded(`the project is deeper than ${limit.maxDepth} directories`);
    const rules: LandlockRule[] = [['l', rel]];
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) { if (onChain(child)) throw new BoundExceeded(`protected product state lies behind a symbolic link (${child})`); continue; }
      if (denied(child)) continue;
      // The write floor holds inside a carved tree too (merge Astra 2170 x MODES-3: a full-access turn's floor, the configuration file,
      // lies under the carved `.deckent`): a floored entry takes a read-only rule, a floored directory's subtree is read-only.
      const inner = cls === 'w' && floored(entry.isDirectory() ? `${child}/-` : child) ? 'r' as const : cls;
      if (entry.isDirectory() && hasProtectedBeneath(child)) rules.push(...await carveProtected(child, depth + 1, inner));
      else if (entry.isDirectory() || entry.isFile()) rules.push([inner, child]);
    }
    return rules;
  };
  /** `cls`: the class clean entries take here — `w`, or `r` inside a write-floor tree. */
  const scan = async (rel: string, depth: number, cls: 'w' | 'r' = 'w'): Promise<readonly LandlockRule[] | null> => {
    let entries: Dirent[];
    const dir = rel === '.' ? root : join(root, rel), ops = fsOps(dir);
    try { entries = await ops.readdir(dir); } catch { return []; }
    if ((seen += entries.length) > limit.maxEntries) throw new BoundExceeded(`the project has more than ${limit.maxEntries} entries to scan`);
    // One verdict per entry, siblings (and their subtrees) examined concurrently: a clean path, carved rules, or nothing (no rule).
    const verdicts = await Promise.all(entries.map(async (entry): Promise<{ readonly clean?: string; readonly rules?: readonly LandlockRule[]; readonly carve: boolean }> => {
      const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
      // `.git`: the inode floor first (Astra 2156) — a multi-linked `.git` file is another name of something and takes no rule; a `.git` link
      // takes none; a `.git` directory is read-only through carved rules (`scanGit`), never one grant over an unchecked tree.
      if (entry.name === '.git') {
        if (entry.isSymbolicLink()) return { rules: [], carve: true };
        if (entry.isDirectory()) return { rules: await scanGit(join(root, child), child, 0), carve: true };
        return { rules: await ops.nlink(join(root, child)) === 1 ? [[git, child]] : [], carve: true };
      }
      if (entry.isSymbolicLink()) { if (onChain(child)) throw new BoundExceeded(`protected product state lies behind a symbolic link (${child})`); return { carve: false }; }
      if (denied(child)) return { carve: true };
      if (entry.isDirectory()) {
        const floor = cls === 'w' && floored(`${child}/-`);
        if (ignoredDirs.has(entry.name)) {
          if (hasProtectedBeneath(child)) return { rules: await carveProtected(child, depth + 1, floor ? 'r' : cls), carve: true };
          return floor ? { rules: [['r', child]], carve: true } : { clean: child, carve: false };
        }
        if (depth + 1 > limit.maxDepth) throw new BoundExceeded(`the project is deeper than ${limit.maxDepth} directories`);
        const inner = await scan(child, depth + 1, floor ? 'r' : cls);
        if (floor) return { rules: inner ?? [['r', child]], carve: true };
        return inner === null ? { clean: child, carve: false } : { rules: inner, carve: true };
      }
      if (!entry.isFile() || await ops.nlink(join(root, child)) !== 1) return { carve: true };
      return cls === 'w' && floored(child) ? { rules: [['r', child]], carve: true } : { clean: child, carve: false };
    }));
    if (!verdicts.some(verdict => verdict.carve) && !anchors.some(path => rel === '.' || path.startsWith(`${rel}/`))) return null;
    return [['l', rel], ...verdicts.flatMap(verdict => verdict.clean ? [[cls, verdict.clean] as const] : []), ...verdicts.flatMap(verdict => verdict.rules ?? [])];
  };
  try {
    const project = await scan('.', 0, projectClass) ?? [[projectClass, '.'] as const];
    const system: LandlockRule[] = [];
    // The Node runtime the service runs on (its bin and lib, not its etc): `node`/`npm` work inside the sandbox. Only an installation
    // prefix (`<prefix>/bin/node`); a node elsewhere (e.g. `~/bin/node`) must not open its parent directory.
    const node = await realpath(process.execPath), prefix = basename(dirname(node)) === 'bin' ? dirname(dirname(node)) : null;
    for (const path of [...SYSTEM_EXEC, ...(prefix ? [join(prefix, 'bin'), join(prefix, 'lib')] : [])]) if (await exists(path, 'dir')) system.push(['x', path]);
    for (const path of SYSTEM_READ) if (await exists(path, 'dir')) system.push(['r', path]);
    // An allow grant on a system prefix would reopen installation authority below it.
    const protectedRoots = await Promise.all((input.hardFloor?.roots ?? [join(root, '.deckent')]).map(path => realpath(path).catch(() => path)));
    if (system.some(([, path]) => protectedRoots.some(protectedRoot => protectedRoot === path || protectedRoot.startsWith(`${path}/`) || path.startsWith(`${protectedRoot}/`)))) {
      return { ok: false, reason: 'a system read grant overlaps the installation hard floor' };
    }
    for (const path of DEVICES) if (await exists(path, 'any')) system.push(['d', path]);
    // The common repository of a worktree (root `.git` file with its own read rule, in the verified shape): read-only under the same floor.
    const commonDir = project.some(([cls, path]) => cls === git && path === '.git') && (await lstat(join(root, '.git'))).isFile() ? await gitWorktreeRepository(root) : null;
    const common = commonDir ? await scanGit(commonDir, commonDir, 0) : [];
    const scratch = input.scratchDir && isAbsolute(input.scratchDir) && await exists(input.scratchDir, 'dir') ? await realpath(input.scratchDir) : null;
    const rules = [...system, ...project, ...common, ...(scratch ? [['w', scratch] as const] : [])];
    if (rules.length > limit.maxRules) return { ok: false, reason: `the rule set needs more than ${limit.maxRules} rules` };
    if (rules.reduce((sum, [, path]) => sum + Buffer.byteLength(path) + 10, 0) > limit.maxBytes) return { ok: false, reason: 'the rule set is too large to pass' };
    return { ok: true, rules };
  } catch (error) {
    if (error instanceof BoundExceeded) return { ok: false, reason: error.message };
    throw error;
  }
}

/** The Landlock realm (S11): each call builds its rule set, then runs `bash` through the native helper, which applies it with
 * no_new_privs and the seccomp socket filter and execs bash in the same process (the host runner's process-group, timeout,
 * cancellation, output and cleanup contract is unchanged). `HOME` is the scratch area (the real one is unreachable). */
export function landlockShellRealm(input: ShellSandboxLayout, abi: number): ShellRealm {
  const refuse = (reason: string): ShellRealmResult => Object.freeze({ status: 'spawn-failed', exitCode: null, signal: null,
    output: `[deckent] sandbox: ${reason}; nothing was run.`, totalBytes: 0, omittedBytes: 0, durationMs: 0, cleanup: 'clean' });
  return Object.freeze({
    kind: 'landlock' as const,
    async run(request: ShellRealmRequest): Promise<ShellRealmResult> {
      if (abi < 3) return refuse('Landlock ABI 3 is required to protect read-only files from truncation');
      if (resolve(request.cwd) !== input.project.root) return refuse('the working directory is not the sandboxed project root');
      // SHELL-OVERLAY: Landlock mounts nothing, so it cannot keep a call's writes aside (design §9); a caller that asks anyway is refused.
      if (request.writeSet) return refuse('this sandbox cannot keep writes aside for review');
      if (!await exists(HELPER, 'any')) return refuse('the sandbox helper is not installed (native build missing)');
      const built = await buildLandlockRules(input, {}, fsOpsFor, { floorReadOnly: request.writeFloorReadOnly === true, projectReadOnly: request.projectReadOnly === true });
      if (!built.ok) return refuse(built.reason);
      const prefix = ['--abi', String(abi), '--root', input.project.root, ...built.rules.flatMap(([cls, path]) => ['--rule', cls, path]), '--'];
      return runShellProcess({ file: HELPER, args: command => [...prefix, BASH_LAUNCH.file, ...BASH_LAUNCH.args(command)], statusChannel: true },
        { ...request, fixedEnv: { ...request.fixedEnv, ...(input.scratchDir ? { HOME: input.scratchDir } : {}) } });
    },
  });
}

/** Landlock ABI 6 scopes signals and abstract unix sockets; below it the realm is typed DEGRADED and says what is left open. */
function landlockPosture(abi: number): { readonly marker: string; readonly posture: (view: ShellSandboxWriteView) => string; readonly notice: string | null;
  readonly containment: 'sandbox' | 'degraded' } {
  const gaps = [...(abi < 6 ? ['signals to other processes of your user are not blocked'] : []),
    ...(abi < 3 ? ['read-only files can be truncated'] : []), ...(abi < 4 ? ['TCP is refused by the socket filter, not by Landlock'] : [])];
  const notice = gaps.length ? `[deckent] sandbox: landlock DEGRADED (kernel Landlock ABI ${abi} < 6): ${gaps.join('; ')}.` : null;
  const posture = (view: ShellSandboxWriteView) => {
    const base = `Runs in the Landlock sandbox (ABI ${abi}): ${describeShellWritePosture(view)}, the conversation scratch area is writable (the project `
      + 'root and folders holding protected files cannot gain or lose entries); protected files, your home directory and other paths '
      + 'unreachable; system paths read-only; no network (sockets refused).';
    return notice ? `${base}\n${notice}` : base;
  };
  return { marker: notice ? 'sandbox: degraded' : 'sandbox: landlock', notice, posture, containment: notice ? 'degraded' : 'sandbox' };
}

/** Landlock as a sandbox provider (S11) for the realm list: usable when the host measurement found a Landlock ABI ≥ 1. */
export function landlockShellSandbox(layout: ShellSandboxLayout): ShellSandbox {
  return Object.freeze({ kind: 'landlock' as const,
    usable(capabilities: ShellCapabilities): ReturnType<ShellSandbox['usable']> {
      const abi = capabilities.landlock.status === 'available' ? capabilities.landlock.abi : null;
      if (abi === null) return { ok: false, reason: `landlock ${capabilities.landlock.status}` };
      if (abi < 3) return { ok: false, reason: `Landlock ABI ${abi} cannot protect read-only files from truncation (requires ABI 3)` };
      return { ok: true, realm: landlockShellRealm(layout, abi), ...landlockPosture(abi) };
    } });
}
