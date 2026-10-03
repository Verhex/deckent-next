import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/**
 * FA-TRACKED-WARN (owner 2026-09-30, option A): what a full-access shell call measurably did to the project's git-tracked files — warn and
 * audit, never block. The command's text is never parsed (shell words are not a boundary); the effect is measured on the file system.
 *
 * Before the call, `git ls-files -z -s` (read from the project root) lists the tracked files of the repository that holds the project —
 * the index only, no working-tree scan, no content hashing, so no clean/smudge filter or other repository-configured program runs — and
 * each listed file is `lstat`ed. After the call the same files are `lstat`ed again: a file present before and gone now is deleted; a file
 * whose inode, size, mtime or ctime changed is overwritten (rewritten, replaced or re-timed; a `chmod` or a new hard link also moves ctime).
 * No git process runs after the command, so a repository the command rewrote (full access writes `.git`) cannot change the measurement or
 * make Deckent run anything. Git documentation (git-scm.com, checked 2026-09-30, git 2.55/2.56 pages; installed git 2.43.0):
 * `git-ls-files(1)` "-z: \0 line termination on output and do not quote filenames", "-s/--stage: [<tag> ]<mode> <object> <stage> <file>",
 * "When run from a subdirectory, the command usually outputs paths relative to the current directory"; `git(1)` `GIT_OPTIONAL_LOCKS`
 * (`--no-optional-locks`), `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL` ("Can be set to /dev/null"), `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`
 * (never inherited here: the environment is built from scratch, so discovery starts at the project root and a worktree's `.git` file and a
 * nested repository resolve as git itself resolves them).
 *
 * Bounds: at most `TRACKED_FILES_MAX` tracked files are measured (beyond, the call says it was not checked); the listing has its own byte
 * and time bound; the `lstat` passes yield to the event loop every `YIELD_EVERY` files. Limits: a change another process makes during the
 * call is attributed to it (the line says "during this call"); submodule entries (mode 160000) and files absent before (sparse checkout,
 * already deleted) are not measured.
 */
export const TRACKED_FILES_MAX = 100_000;
/** Paths one visible line names per list (its count is always the full number). */
export const TRACKED_FILES_LINE_PATHS = 8;
export const LISTING_MAX_BYTES = 64 * 1024 * 1024;
export const LISTING_TIMEOUT_MS = 5_000;
const YIELD_EVERY = 4_096;
const GITLINK_MODE = '160000';
/** The same fixed environment as the git-patch adapter's `GIT_LOCAL_ENV` (`git-patch/internal/local-git.ts`; host-shell may not depend on it,
 * arch.json): no system/global configuration, no prompt, no transport, no optional lock; `LC_ALL=C` so the "not a repository" answer is stable. */
const GIT_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });

/** What was known before the call: the measured tracked files, nothing to measure (not a git project), too many files, or git could not answer. */
export type TrackedFilesBaseline =
  | { readonly kind: 'measured'; readonly root: string; readonly paths: readonly string[]; readonly stats: readonly (string | null)[] }
  | { readonly kind: 'none' } | { readonly kind: 'over-bound'; readonly count: number; readonly bound: number } | { readonly kind: 'unavailable' };
export interface TrackedFilesList { readonly count: number; readonly paths: readonly string[] }
export interface TrackedFilesChange { readonly deleted: TrackedFilesList; readonly overwritten: TrackedFilesList }

const pause = () => new Promise<void>(resolve => setImmediate(resolve));
/** One file's identity: inode, size, mtime and ctime in nanoseconds (kernel-set ctime moves on any content write, whatever mtime says); null when absent. */
function identity(path: string): string | null {
  try {
    const info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return info ? `${info.mode & 0o170000n}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : null;
  } catch (error) {
    // A parent replaced by a file reads as absent; any other failure is its own identity (compared, never guessed).
    return (error as { code?: unknown }).code === 'ENOTDIR' ? null : `error:${String((error as { code?: unknown }).code)}`;
  }
}
async function identities(root: string, paths: readonly string[]): Promise<(string | null)[]> {
  const out = new Array<string | null>(paths.length);
  for (let index = 0; index < paths.length; index++) {
    if (index > 0 && index % YIELD_EVERY === 0) await pause();
    out[index] = identity(join(root, paths[index]!));
  }
  return out;
}
function listTracked(root: string): Promise<{ readonly ok: true; readonly stdout: Buffer } | { readonly ok: false; readonly repository: boolean }> {
  return new Promise(resolve => {
    execFile('git', ['--no-replace-objects', '-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'ls-files', '-z', '-s'],
      { env: GIT_ENV, encoding: 'buffer', maxBuffer: LISTING_MAX_BYTES, timeout: LISTING_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) { resolve({ ok: true, stdout }); return; }
        // Exit 128 with "not a git repository": no repository holds the project — nothing to measure. Anything else: git could not answer.
        const notRepository = (error as { code?: unknown }).code === 128 && /not a git repository/iu.test(Buffer.from(stderr ?? '').toString('utf8'));
        resolve({ ok: false, repository: !notRepository });
      });
  });
}

/** The tracked files of the repository holding `root`, measured before a call (bounded; never throws). */
export async function snapshotTrackedFiles(root: string, max = TRACKED_FILES_MAX): Promise<TrackedFilesBaseline> {
  try {
    const listed = await listTracked(root);
    if (!listed.ok) return listed.repository ? { kind: 'unavailable' } : { kind: 'none' };
    const seen = new Set<string>(), paths: string[] = [];
    for (const entry of listed.stdout.toString('utf8').split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0 || entry.startsWith(GITLINK_MODE)) continue;
      const path = entry.slice(tab + 1);
      // A conflicted path has one entry per stage: measured once.
      if (!seen.has(path)) { seen.add(path); paths.push(path); }
    }
    if (paths.length > max) return { kind: 'over-bound', count: paths.length, bound: max };
    return { kind: 'measured', root, paths, stats: await identities(root, paths) };
  } catch { return { kind: 'unavailable' }; }
}

/** The tracked files the call deleted or overwrote (null when none), measured against the baseline; never throws. */
export async function compareTrackedFiles(baseline: Extract<TrackedFilesBaseline, { kind: 'measured' }>): Promise<TrackedFilesChange | null> {
  const now = await identities(baseline.root, baseline.paths);
  const deleted: string[] = [], overwritten: string[] = [];
  baseline.stats.forEach((before, index) => {
    if (before === null) return;
    const after = now[index];
    if (after === null) deleted.push(baseline.paths[index]!);
    else if (after !== before) overwritten.push(baseline.paths[index]!);
  });
  if (deleted.length === 0 && overwritten.length === 0) return null;
  return { deleted: { count: deleted.length, paths: deleted }, overwritten: { count: overwritten.length, paths: overwritten } };
}

/** A path as one line shows it: control characters (a newline in a file name) become `?`, so a name can never forge another line. */
// eslint-disable-next-line no-control-regex
const oneLine = (path: string) => path.replace(/[\u0000-\u001f\u007f]/gu, '?');
/** `a, b, … +N more`: at most `max` names of a list, then how many more. */
function names(list: TrackedFilesList, max: number): string {
  const shown = list.paths.slice(0, max).map(oneLine).join(', ');
  return list.count > max ? `${shown}, … +${list.count - max} more` : shown;
}
/** The visible line (stream, result text, the model): `[deckent] tracked files changed: deleted N (a, b…), overwritten M (…)`. */
export function describeTrackedFilesChange(change: TrackedFilesChange, audited = true, max = TRACKED_FILES_LINE_PATHS): string {
  const part = (word: string, list: TrackedFilesList) => `${word} ${list.count}${list.count > 0 ? ` (${names(list, max)})` : ''}`;
  return `[deckent] tracked files changed: ${part('deleted', change.deleted)}, ${part('overwritten', change.overwritten)} — during this full-access call; nothing was blocked`
    + (audited ? '.' : '; the audit record of this could not be written.');
}
/** The line for a call whose tracked files were not measured (null when there was nothing to measure). */
export function describeTrackedFilesUnchecked(baseline: TrackedFilesBaseline): string | null {
  if (baseline.kind === 'over-bound') return `[deckent] tracked files: not checked for this call (${baseline.count} tracked files exceed the bound of ${baseline.bound}).`;
  return baseline.kind === 'unavailable' ? '[deckent] tracked files: not checked for this call (git could not list them).' : null;
}
