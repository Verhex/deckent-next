import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { runBaseRepository, runBasesRoot, type GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { gitBlobOid, hashAlgorithmOf, isPatchExcluded, SnapshotBudget, WorkspacePatchError, type PatchLimits } from '#engine/index.js';
import { GitCommand } from './git-command.js';
import { copyPrivateCommit } from './copy-private.js';
import { readTreeFile } from './working-tree.js';
import format from './working-tree-format.json' with { type: 'json' };
const recordSchema = z.strictObject({ schemaVersion: z.literal(1), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), count: z.number().int().nonnegative(),
  excluded: z.array(z.strictObject({ path: z.string().min(1), rule: z.string().min(1) }).readonly()).readonly(),
  /** L1c: the Run the repository belongs to (the start sweep reads it; a record without it is never removed by the sweep). */
  run: z.strictObject({ scopeId: z.string().min(1), runId: z.string().min(1) }).readonly().optional() }).readonly();
export type WorkingTreeBase = z.infer<typeof recordSchema> & Readonly<{ options: GitWorkspaceOptions }>;
const code = (error: unknown) => (error as { code?: unknown } | null)?.code;
/** Why a path was not read: what the descriptor-relative reader refused, named from its (non-followed) directory entry. */
async function unsafeKind(path: string) {
  const stat = await lstat(path).catch(() => null);
  return !stat ? 'unsafe-path' : stat.isSymbolicLink() ? 'symlink' : !stat.isFile() ? 'special-file' : stat.nlink !== 1 ? 'hard-link' : stat.uid !== process.getuid!() ? 'owner' : 'unsafe-path';
}

/** `check-attr --source <tree>` reads `.gitattributes` from a commit: Git 2.40.0 (RelNotes/2.40.0 "git check-attr learned to take an optional
 * tree-ish"; absent from the v2.39.0 manual), read 2026-11-09. Below it the base is a typed refusal, never a base without HEAD's attributes. */
const ATTR_SOURCE_GIT = [2, 40, 0] as const;
/** A6-1 (owner 2026-11-08, M2): every path whose `filter` attribute is set in either attribute view (any value but unset/unspecified). */
async function filterAttributes(git: GitCommand, paths: readonly string[], source: string | null, deadline: number, filtered: Map<string, string>) {
  const fields = (await git.run(['check-attr', ...source ? ['--source', source] : [], '-z', '--stdin', 'filter'], paths.map(path => `${path}\0`).join(''), undefined, deadline)).split('\0');
  for (let at = 0; at + 2 < fields.length; at += 3) if (fields[at + 2] !== 'unspecified' && fields[at + 2] !== 'unset' && !filtered.has(fields[at]!)) filtered.set(fields[at]!, fields[at + 2]!);
}

/**
 * Owner 2026-11-05 (R9n, "gizlileri dışarıda tut"): the Run's base is a commit of the person's current files in a private repository Deckent owns
 * (`runBaseRepository`); the person's repository is only read and only HEAD's reachable objects are copied in (`pack-objects --revs`).
 * A6-1 (owner 2026-11-07/08): Git never hashes the person's files, so no filter driver runs in the service: each HEAD file, index entry and
 * unignored untracked file is opened by `readTreeFile` (O_NOFOLLOW, owner, one link, regular file) and one of its HEAD entry's mode and size is
 * stream-hashed by Deckent, staying HEAD's when equal. A filtered path (K-1, M2: `filter` set in HEAD's attributes, read in the private repository,
 * or in the person's view) is never opened: it keeps its HEAD blob and is withheld as `filter:<driver>`; delivery refuses a patch writing it.
 * A configured driver no attribute names, and a Git below the `check-attr --source` floor, are typed refusals. A deny-listed, patch-excluded,
 * product-state or over-budget path is never opened, read or hashed (an unsafe one is never read): a tracked one keeps HEAD, an untracked one
 * is absent, and each is `excluded` (path, rule), a withheld HEAD file even when unchanged. Built in a fresh directory and renamed into place: concurrent first attempts share the winner.
 */
export async function captureWorkingTreeBase(options: GitWorkspaceOptions, run: Readonly<{ scopeId: string; runId: string }>, limits: PatchLimits,
  deny: (path: string) => string | null): Promise<WorkingTreeBase> {
  if (process.platform !== 'linux') throw new WorkspacePatchError('PATCH_WORKING_TREE_UNSUPPORTED'); // descriptor-relative reads need /proc: never a silently empty base
  const repository = runBaseRepository(options.workspaceRoot, run), recorded = async () => ({ ...recordSchema.parse(JSON.parse(await readFile(join(repository, format.base), 'utf8'))), options: { ...options, runBase: repository } });
  try { return await recorded(); } catch (error) { if (code(error) !== 'ENOENT') throw new WorkspacePatchError('PATCH_CORRUPT'); }
  const source = new GitCommand(options), deadline = Date.now() + options.timeoutMs, list = (output: string) => output.split('\0').filter(Boolean);
  // Typed and permanent (never retried): a subfolder project (Git lists paths from the top folder) and an unignored file list over `outputBytes`.
  if (await realpath(await source.run(['rev-parse', '--show-toplevel'])) !== await realpath(options.sourceRoot)) throw new WorkspacePatchError('PATCH_WORKING_TREE_SUBFOLDER');
  const found = /^git version (\d+)\.(\d+)\.(\d+)/.exec(await source.run(['version'])), number = (parts: readonly number[]) => parts[0]! * 1e6 + parts[1]! * 1e3 + parts[2]!;
  if (!found || number(found.slice(1).map(Number)) < number(ATTR_SOURCE_GIT))
    throw new WorkspacePatchError('PATCH_WORKING_TREE_GIT_VERSION', undefined, { found: found ? found.slice(1).join('.') : '?', required: ATTR_SOURCE_GIT.join('.') });
  const limited = (error: unknown) => {
    throw error instanceof WorkspacePatchError && error.detail === 'git-output' ? new WorkspacePatchError('PATCH_WORKING_TREE_LISTING_LIMIT', undefined, { limit: options.outputBytes, maxEntries: limits.maxEntries }) : error; };
  const listed = (args: string[]) => source.run(args).then(list, limited);
  const head = await source.run(['rev-parse', '--verify', 'HEAD^{commit}']), algorithm = hashAlgorithmOf(head), known = new Map<string, Readonly<{ mode: string; size: number; oid: string }>>();
  for (const entry of await listed(['ls-tree', '-r', '-z', '-l', '--full-tree', head])) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64}) +(-|\d+)\t/u.exec(entry); if (!match) throw new WorkspacePatchError('PATCH_UNSAFE');
    if (match[2] === 'blob') known.set(entry.slice(match[0].length), { mode: match[1]!, size: Number(match[4]), oid: match[3]! }); // a submodule (gitlink) keeps HEAD
  }
  const staged = (await listed(['ls-files', '-z', '--stage'])).flatMap(entry => entry.startsWith('160000 ') ? [] : [entry.slice(entry.indexOf('\t') + 1)]);
  const paths = [...new Set([...known.keys(), ...staged, ...await listed(['ls-files', '-z', '--others', '--exclude-standard'])])].sort();
  await mkdir(dirname(repository), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(repository), `.${randomUUID()}`), index = join(temporary, format.baseIndex);
  try {
    await new GitCommand({ ...options, sourceRoot: dirname(repository) }).run(['init', '-q', '--bare', '--template=', `--object-format=${algorithm}`, temporary]);
    await chmod(temporary, 0o700); await copyPrivateCommit(options, options.sourceRoot, temporary, head);
    const base = new GitCommand({ ...options, sourceRoot: temporary }), excluded: { path: string; rule: string }[] = [], entries: string[] = [], filtered = new Map<string, string>(); let used = 0, read = 0;
    // M2: HEAD's attributes come from the private repository (no worktree, `info/attributes` or `core.attributesFile` of the person's there).
    await filterAttributes(base, paths, head, deadline, filtered).catch(limited); await filterAttributes(source, paths, null, deadline, filtered).catch(limited);
    const named = new Set([...filtered.values()].map(value => value || '""'));
    const drivers = [...new Set(list(await source.run(['config', '--list', '--null', '--includes'])).map(entry => entry.split('\n', 1)[0]!)
      .filter(key => key.startsWith('filter.')).map(key => key.slice('filter.'.length, key.lastIndexOf('.')) || '""'))].filter(driver => !named.has(driver)); // an empty name is a driver too (Astra 3038)
    if (drivers.length) throw new WorkspacePatchError('PATCH_WORKING_TREE_FILTER', undefined, { drivers: drivers.join(', ') });
    await base.run(['read-tree', head], '', index, deadline);
    const root = await open(options.sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const path of paths) {
        const blob = known.get(path), driver = filtered.get(path);
        if (driver !== undefined) { excluded.push({ path, rule: `filter:${driver.slice(0, 200)}` }); continue; } // K-1: its HEAD blob (or absent), never the file
        const rule = path.endsWith('/') ? 'nested-repository' : isPatchExcluded(path) ? 'patch-excluded' : read >= limits.maxEntries ? 'size' : deny(path);
        if (rule) { excluded.push({ path, rule }); continue; } // never opened, read or hashed: a HEAD one keeps its blob and is listed even when unchanged
        let file;
        try { file = await readTreeFile(root, path, new SnapshotBudget({ ...limits, maxBytes: limits.maxBytes - used }, deadline), blob && { ...blob, algorithm }); }
        catch (error) {
          if (!(error instanceof WorkspacePatchError) || error.detail === 'time') throw error;
          const kind = error.code === 'PATCH_LIMIT' ? 'size' : await unsafeKind(join(options.sourceRoot, path));
          // An unchanged tracked symlink is HEAD's own entry, not a withheld file.
          if (kind === 'symlink' && blob?.mode === '120000' && gitBlobOid(await readlink(join(options.sourceRoot, path), { encoding: 'buffer' }).catch(() => Buffer.alloc(0)), algorithm) === blob.oid) continue;
          excluded.push({ path, rule: kind }); continue;
        }
        if (file === 'unchanged') continue;
        if (file) {
          used += file.bytes.length; read++;
          if (gitBlobOid(file.bytes, algorithm) !== blob?.oid || file.mode !== blob.mode) entries.push(`${file.mode} ${await base.run(['hash-object', '-w', '--no-filters', '--stdin'], file.bytes, undefined, deadline)}\t${path}\0`);
        } else if (blob) entries.push(`0 ${'0'.repeat(blob.oid.length)}\t${path}\0`);
      }
    } finally { await root.close(); }
    if (entries.length) await base.run(['update-index', '-z', '--index-info'], entries.join(''), index, deadline);
    const tree = await base.run(['write-tree'], '', index, deadline);
    const commit = tree === await base.run(['rev-parse', `${head}^{tree}`]) ? head : await base.run(['commit-tree', tree, '-p', head], format.baseMessage, undefined, deadline);
    await base.run(['update-ref', '--no-deref', 'HEAD', commit]); await rm(index);
    await writeFile(join(temporary, format.base), JSON.stringify({ schemaVersion: 1, commit, count: excluded.length, excluded, run: { scopeId: run.scopeId, runId: run.runId } }), { flag: 'wx', mode: 0o600 });
    // A concurrent first attempt of the same Run that won keeps its base; this one is discarded.
    await rename(temporary, repository).catch((error: unknown) => { if (code(error) !== 'ENOTEMPTY' && code(error) !== 'EEXIST') throw error; });
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return recorded();
}
/** K-1 (owner 2026-11-08): the filtered paths a working-tree Run's base kept at HEAD (`filter:*`); empty when the base is absent (its later use is typed). */
export async function filteredBasePaths(workspaceRoot: string, run: Readonly<{ scopeId: string; runId: string }>) {
  const text = await readFile(join(runBaseRepository(workspaceRoot, run), format.base), 'utf8').catch((error: unknown) => { if (code(error) === 'ENOENT') return null; throw error; });
  if (text === null) return new Set<string>();
  const record = recordSchema.safeParse(JSON.parse(text)); if (!record.success) throw new WorkspacePatchError('PATCH_CORRUPT');
  return new Set(record.data.excluded.filter(entry => entry.rule.startsWith('filter:')).map(entry => entry.path));
}

type RunRef = Readonly<{ scopeId: string; runId: string }>;
const TEMPORARY = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** A directory Deckent made here: real (no link), owned by this uid, private (no group/other bits); null when absent. Anything else is PATCH_UNSAFE (kept). */
async function privateDirectory(path: string) {
  const stat = await lstat(path).catch((error: unknown) => { if (code(error) === 'ENOENT') return null; throw error; });
  if (stat && (!stat.isDirectory() || stat.uid !== process.getuid!() || stat.mode & 0o077 || await realpath(path) !== path)) throw new WorkspacePatchError('PATCH_UNSAFE');
  return stat;
}
/**
 * L1c: a settled Run's private base repository is Deckent data and goes: verified (private, owned, under `run-bases`, its base record naming this Run),
 * detached by one rename into a temporary name, then removed recursively. Never a path outside `run-bases`; the person's repository is never touched.
 */
export async function removeRunBase(workspaceRoot: string, run: RunRef): Promise<'removed' | 'absent'> {
  const repository = runBaseRepository(workspaceRoot, run);
  if (!await privateDirectory(repository)) return 'absent';
  const record = recordSchema.safeParse(JSON.parse(await readFile(join(repository, format.base), 'utf8').catch(() => 'null')));
  if (!record.success || record.data.run?.scopeId !== run.scopeId || record.data.run.runId !== run.runId) throw new WorkspacePatchError('PATCH_UNSAFE');
  const detached = join(dirname(repository), `.${randomUUID()}`); await rename(repository, detached); await rm(detached, { recursive: true, force: true });
  return 'removed';
}
/** L1c start sweep: crash remnants (`.<uuid>` temporaries of a capture or a removal) older than `staleAfterMs` are removed (verified private, owned);
 * the Runs of recorded bases are returned (at most `limit`) for the caller's ledger check. A missing `run-bases` is an empty sweep. */
export async function sweepRunBases(workspaceRoot: string, gitTimeoutMs: number, limit: number) {
  const staleAfterMs = format.baseStaleAfterGitTimeouts * gitTimeoutMs; // a capture makes a bounded number of Git calls, each within `timeoutMs`
  const root = runBasesRoot(workspaceRoot), runs: RunRef[] = []; let removed = 0, kept = 0;
  for (const name of await readdir(root).catch((error: unknown) => { if (code(error) === 'ENOENT') return [] as string[]; throw error; })) {
    const path = join(root, name);
    try {
      if (TEMPORARY.test(name)) { const stat = await privateDirectory(path); if (stat && stat.mtimeMs < Date.now() - staleAfterMs && removed < limit) { await rm(path, { recursive: true, force: true }); removed++; } else kept++; continue; }
      if (runs.length >= limit || !/^[0-9a-f]{64}$/u.test(name) || !await privateDirectory(path)) continue;
      const record = recordSchema.safeParse(JSON.parse(await readFile(join(path, format.base), 'utf8')));
      if (record.success && record.data.run && runBaseRepository(workspaceRoot, record.data.run) === path) runs.push(record.data.run);
    } catch { kept++; }
  }
  return Object.freeze({ removed, kept, runs: Object.freeze(runs) });
}
