import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { runBaseRepository, runBasesRoot, type GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { isPatchExcluded, SnapshotBudget, WorkspacePatchError, type PatchLimits } from '#engine/index.js';
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

/**
 * Owner 2026-11-05 (R9n, checkpoint "gizlileri dışarıda tut"): the Run's base is a commit of the person's current files in a private repository
 * Deckent owns (one per Run, `runBaseRepository`); nothing is written to the person's repository (it is only read: HEAD, `diff-index`, `ls-files`).
 * Only the objects reachable from HEAD are copied in (`pack-objects --revs`, never the person's unreachable objects); then every tracked path that
 * differs from HEAD and every untracked file outside `.gitignore`/`.git/info/exclude` is read through `readTreeFile` (O_NOFOLLOW, owner, one link,
 * regular files only) and hashed there. A path on the S6 deny list (`deny`), under a patch exclusion or a product-state root, a symlink, hard link,
 * foreign-owned or special file, or one over the snapshot budget is never read or hashed: a tracked one keeps its HEAD version, an untracked one is
 * absent, and each is returned as `excluded` (path, rule). The repository's detached HEAD is the base; a clean tree's base is HEAD itself.
 * Built in a fresh directory and renamed into place: concurrent first attempts of one Run share the winner, and a recorded base is reused as is.
 */
export async function captureWorkingTreeBase(options: GitWorkspaceOptions, run: Readonly<{ scopeId: string; runId: string }>, limits: PatchLimits,
  deny: (path: string) => string | null): Promise<WorkingTreeBase> {
  if (process.platform !== 'linux') throw new WorkspacePatchError('PATCH_WORKING_TREE_UNSUPPORTED'); // descriptor-relative reads need /proc: never a silently empty base
  const repository = runBaseRepository(options.workspaceRoot, run), recorded = async () => ({ ...recordSchema.parse(JSON.parse(await readFile(join(repository, format.base), 'utf8'))), options: { ...options, runBase: repository } });
  try { return await recorded(); } catch (error) { if (code(error) !== 'ENOENT') throw new WorkspacePatchError('PATCH_CORRUPT'); }
  const source = new GitCommand(options), deadline = Date.now() + options.timeoutMs, list = (output: string) => output.split('\0').filter(Boolean);
  // Typed and permanent (never retried): a subfolder project (Git lists paths from the top folder) and an unignored file list over `outputBytes`.
  if (await realpath(await source.run(['rev-parse', '--show-toplevel'])) !== await realpath(options.sourceRoot)) throw new WorkspacePatchError('PATCH_WORKING_TREE_SUBFOLDER');
  const listed = (args: string[]) => source.run(args).then(list, (error: unknown) => {
    throw error instanceof WorkspacePatchError && error.detail === 'git-output' ? new WorkspacePatchError('PATCH_WORKING_TREE_LISTING_LIMIT', undefined, { limit: options.outputBytes, maxEntries: limits.maxEntries }) : error; });
  const head = await source.run(['rev-parse', '--verify', 'HEAD^{commit}']);
  const tracked = new Set(await listed(['diff-index', '-z', '--name-only', '--no-renames', '--ignore-submodules', head, '--']));
  const paths = [...new Set([...tracked, ...await listed(['ls-files', '-z', '--others', '--exclude-standard'])])].sort();
  await mkdir(dirname(repository), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(repository), `.${randomUUID()}`), index = join(temporary, format.baseIndex);
  try {
    await new GitCommand({ ...options, sourceRoot: dirname(repository) }).run(['init', '-q', '--bare', '--template=', `--object-format=${head.length === 64 ? 'sha256' : 'sha1'}`, temporary]);
    await chmod(temporary, 0o700); await copyPrivateCommit(options, options.sourceRoot, temporary, head);
    const base = new GitCommand({ ...options, sourceRoot: temporary }), excluded: { path: string; rule: string }[] = [], entries: string[] = []; let used = 0;
    await base.run(['read-tree', head], '', index, deadline);
    const root = await open(options.sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const [at, path] of paths.entries()) {
        const rule = path.endsWith('/') ? 'nested-repository' : isPatchExcluded(path) ? 'patch-excluded' : at >= limits.maxEntries ? 'size' : deny(path);
        if (rule) { excluded.push({ path, rule }); continue; }
        let file;
        try { file = await readTreeFile(root, path, new SnapshotBudget({ ...limits, maxBytes: limits.maxBytes - used }, deadline)); }
        catch (error) {
          if (!(error instanceof WorkspacePatchError) || error.detail === 'time') throw error;
          excluded.push({ path, rule: error.code === 'PATCH_LIMIT' ? 'size' : await unsafeKind(join(options.sourceRoot, path)) }); continue;
        }
        if (file) { used += file.bytes.length; entries.push(`${file.mode} ${await base.run(['hash-object', '-w', '--stdin'], file.bytes, undefined, deadline)}\t${path}\0`); }
        else if (tracked.has(path)) entries.push(`0 ${'0'.repeat(head.length)}\t${path}\0`);
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
