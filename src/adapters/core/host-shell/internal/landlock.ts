import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShellRealm, ShellRealmRequest, ShellRealmResult } from '#domain/index.js';
import { runHostShell } from './run.js';

/** Rule classes the native helper maps to Landlock rights: `x` read + execute, `r` read, `w` read-write (no device nodes),
 * `l` list the directory only, `d` a device file (read/write). */
export type LandlockRuleClass = 'x' | 'r' | 'w' | 'l' | 'd';
export type LandlockRule = readonly [LandlockRuleClass, string];
/** The turn's workspace boundary (structurally the read tools' `WorkspaceScope`): the same deny predicate and ignored directory names. */
export interface ShellSandboxScope { readonly root: string; denied(rel: string): boolean; readonly ignoredDirs: ReadonlySet<string> }
export interface LandlockSandboxInput { readonly scope: ShellSandboxScope; readonly scratchDir: string | null }
export const LANDLOCK_RULE_BOUNDS = Object.freeze({ maxEntries: 20_000, maxDepth: 32, maxRules: 8_192, maxBytes: 1_048_576 });
export type LandlockRuleSet = { readonly ok: true; readonly rules: readonly LandlockRule[] } | { readonly ok: false; readonly reason: string };

const HELPER = fileURLToPath(new URL('../native/build/Release/shell-sandbox', import.meta.url));
const SYSTEM_EXEC = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/opt'];
const SYSTEM_READ = ['/etc', '/proc'];
const DEVICES = ['/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom'];

class BoundExceeded extends Error {}
const exists = async (path: string, kind: 'dir' | 'any') => { try { const info = await stat(path); return kind === 'any' || info.isDirectory(); } catch { return false; } };

/** A git worktree's `.git` file (at the project root only) opens its repository read-only, and only when it has the worktree shape:
 * `gitdir: <common>/worktrees/<name>` whose `commondir` names `<common>` again. Any other `.git` file opens nothing outside. */
async function worktreeCommonDir(root: string): Promise<string | null> {
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
export async function buildLandlockRules(input: LandlockSandboxInput, bounds: Partial<typeof LANDLOCK_RULE_BOUNDS> = {}): Promise<LandlockRuleSet> {
  const limit = { ...LANDLOCK_RULE_BOUNDS, ...bounds }, { root, denied, ignoredDirs } = input.scope;
  let seen = 0;
  const scan = async (rel: string, depth: number): Promise<readonly LandlockRule[] | null> => {
    let entries: Dirent[];
    try { entries = await readdir(rel === '.' ? root : join(root, rel), { withFileTypes: true }); } catch { return []; }
    if ((seen += entries.length) > limit.maxEntries) throw new BoundExceeded(`the project has more than ${limit.maxEntries} entries to scan`);
    // One verdict per entry, siblings (and their subtrees) examined concurrently: a clean path, carved rules, or nothing (no rule).
    const verdicts = await Promise.all(entries.map(async (entry): Promise<{ readonly clean?: string; readonly rules?: readonly LandlockRule[]; readonly carve: boolean }> => {
      const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
      // `.git` (a directory, or a worktree/submodule file) is read-only; a `.git` link is not followed and takes no rule.
      if (entry.name === '.git') return { rules: entry.isSymbolicLink() ? [] : [['r', child]], carve: true };
      if (entry.isSymbolicLink()) return { carve: false };
      if (denied(child)) return { carve: true };
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) return { clean: child, carve: false };
        if (depth + 1 > limit.maxDepth) throw new BoundExceeded(`the project is deeper than ${limit.maxDepth} directories`);
        const inner = await scan(child, depth + 1);
        return inner === null ? { clean: child, carve: false } : { rules: inner, carve: true };
      }
      return entry.isFile() && await lstat(join(root, child)).then(info => info.nlink === 1, () => false) ? { clean: child, carve: false } : { carve: true };
    }));
    if (!verdicts.some(verdict => verdict.carve)) return null;
    return [['l', rel], ...verdicts.flatMap(verdict => verdict.clean ? [['w', verdict.clean] as const] : []), ...verdicts.flatMap(verdict => verdict.rules ?? [])];
  };
  try {
    const project = await scan('.', 0) ?? [['w', '.'] as const];
    const system: LandlockRule[] = [];
    // The Node runtime the service runs on (its bin and lib, not its etc): `node`/`npm` work inside the sandbox. Only an installation
    // prefix (`<prefix>/bin/node`); a node elsewhere (e.g. `~/bin/node`) must not open its parent directory.
    const node = await realpath(process.execPath), prefix = basename(dirname(node)) === 'bin' ? dirname(dirname(node)) : null;
    for (const path of [...SYSTEM_EXEC, ...(prefix ? [join(prefix, 'bin'), join(prefix, 'lib')] : [])]) if (await exists(path, 'dir')) system.push(['x', path]);
    for (const path of SYSTEM_READ) if (await exists(path, 'dir')) system.push(['r', path]);
    for (const path of DEVICES) if (await exists(path, 'any')) system.push(['d', path]);
    const common = project.some(([cls, path]) => cls === 'r' && path === '.git') && (await lstat(join(root, '.git'))).isFile() ? await worktreeCommonDir(root) : null;
    const scratch = input.scratchDir && isAbsolute(input.scratchDir) && await exists(input.scratchDir, 'dir') ? await realpath(input.scratchDir) : null;
    const rules = [...system, ...project, ...(common ? [['r', common] as const] : []), ...(scratch ? [['w', scratch] as const] : [])];
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
export function landlockShellRealm(input: LandlockSandboxInput, abi: number): ShellRealm {
  const refuse = (reason: string): ShellRealmResult => Object.freeze({ status: 'spawn-failed', exitCode: null, signal: null,
    output: `[deckent] sandbox: ${reason}; nothing was run.`, totalBytes: 0, omittedBytes: 0, durationMs: 0, cleanup: 'clean' });
  return Object.freeze({
    kind: 'landlock' as const,
    async run(request: ShellRealmRequest): Promise<ShellRealmResult> {
      if (resolve(request.cwd) !== input.scope.root) return refuse('the working directory is not the sandboxed project root');
      if (!await exists(HELPER, 'any')) return refuse('the sandbox helper is not installed (native build missing)');
      const built = await buildLandlockRules(input);
      if (!built.ok) return refuse(built.reason);
      const prefix = ['--abi', String(abi), '--root', input.scope.root, ...built.rules.flatMap(([cls, path]) => ['--rule', cls, path]), '--'];
      return runHostShell({ ...request, fixedEnv: { ...request.fixedEnv, ...(input.scratchDir ? { HOME: input.scratchDir } : {}) } }, undefined,
        { program: HELPER, prefix });
    },
  });
}
