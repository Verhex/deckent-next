import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { workerTreeDenyForms } from '#engine/index.js';
import { ErrorRegistry, redactForRecord } from '#platform/index.js';
import { createGlobMatcher, CREDENTIAL_WORKSPACE_DENY } from '#adapters/core/workspace-read/index.js';
import { configSecretHit, isConfigFile, WORKER_TREE_PATTERN_RULES } from '#adapters/core/worker-tree-gate/index.js';
import { findExecutable, type DetectEnvironment } from '#adapters/core/setup-detect-execution/index.js';
import registry from './coding.json' with { type: 'json' };
import { inspectFirstCommitRecovery, recoveryNames } from './first-commit-recovery.js';
import { sha256 } from '#platform/index.js';

/** The typed operation id a setup stage or card names (U3U4U7 §3.8); the stage itself and its card belong to U3-1/U4-1. */
export const FIRST_COMMIT_OPERATION_ID = 'coding.first-commit@1' as const;
export type FirstCommitFlag = 'secret-name' | 'secret-content' | 'size' | 'nested-repository';
export type FirstCommitRow = Readonly<{ path: string; bytes: number; flag: FirstCommitFlag | null }>;
/** `offered`: HEAD unborn and nothing staged. Flagged rows come first and are excluded unless named in `include`; `digest` binds the selection
 * and the message, so the apply commits exactly what the card showed. Hooks never run (plumbing); `sign` mirrors the person's commit.gpgSign. */
export type FirstCommitPreview = Readonly<{ state: 'has-commits' }> | Readonly<{ state: 'staged' }> | Readonly<{ state: 'offered'; operation: typeof FIRST_COMMIT_OPERATION_ID;
  identity: boolean; sign: boolean; hooks: 'not-run'; total: number; selected: number; flagged: number; rows: readonly FirstCommitRow[]; more: number; digest: string }>;
export type FirstCommitResult = Readonly<{ operation: typeof FIRST_COMMIT_OPERATION_ID; commit: string; tree: string; files: number; signed: boolean }>;
export type FirstCommitGitResult = Readonly<{ code: number | null; stdout: string; stderr: string; overflow: boolean }>;
/** One Git process in the person's environment; `index` is a GIT_INDEX_FILE. The port the focused test wraps to inject a ref race. */
export type FirstCommitGit = (args: readonly string[], options?: Readonly<{ input?: string; index?: string; timeoutMs?: number; outputBytes?: number }>) => Promise<FirstCommitGitResult>;
type Request = Readonly<{ root: string; env: DetectEnvironment; message: string; include?: readonly string[]; signal?: AbortSignal; git?: FirstCommitGit; effectKey?: string }>;

const { git: gitRegistry, limits: detectLimits, firstCommit: policy } = registry, limits = policy.limits;
const denied = CREDENTIAL_WORKSPACE_DENY.map(pattern => createGlobMatcher(pattern.toLowerCase()));
const shapes = WORKER_TREE_PATTERN_RULES.map(rule => new RegExp(rule.source, rule.flags));
const refuse = (code: string, params?: Record<string, string | number>): never => { throw ErrorRegistry.createError(code, params ? { params } : undefined); };
const lastLine = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '-';
/** A failed step 1-5: nothing was written; the detail is Git's last stderr line, redacted and bounded. */
const step = (name: string, result: FirstCommitGitResult) => result.code === 0 ? result.stdout : refuse('SETUP_FIRST_COMMIT_FAILED',
  { step: name, detail: redactForRecord(lastLine(result.stderr)).slice(0, limits.detailChars) });
/** A file-system step that failed: typed, with the errno code only (never a path or content). */
const io = (name: string) => (error: NodeJS.ErrnoException): never => refuse('SETUP_FIRST_COMMIT_FAILED', { step: name, detail: error.code ?? 'io' });

/** The person's Git (their config, identity and signing), with the repository-redirecting variables removed and the safety ones set. */
export async function firstCommitGit(root: string, env: DetectEnvironment, signal?: AbortSignal): Promise<FirstCommitGit> {
  const executable = await findExecutable(gitRegistry.executable, env, detectLimits.pathDirectories, signal ?? AbortSignal.timeout(detectLimits.totalTimeoutMs));
  if (!executable) refuse('SETUP_FIRST_COMMIT_FAILED', { step: 'git', detail: gitRegistry.executable });
  const base = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !policy.stripEnv.includes(entry[0])));
  let directory = root;
  const run: FirstCommitGit = (args, options = {}) => new Promise(done => {
    const child = execFile(executable!, [...gitRegistry.prefix, ...args], { cwd: directory, encoding: 'utf8', timeout: options.timeoutMs ?? detectLimits.commandTimeoutMs,
      maxBuffer: options.outputBytes ?? detectLimits.outputBytes, ...(signal ? { signal } : {}),
      env: { ...base, ...policy.env, ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) } }, (error, stdout, stderr) => {
      const failure = error as (Error & { code?: unknown; killed?: boolean }) | null;
      done({ code: !failure ? 0 : typeof failure.code === 'number' && !failure.killed ? failure.code : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
        overflow: failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    });
    child.stdin?.on('error', () => undefined); child.stdin?.end(options.input ?? '');
  });
  const top = await run(['rev-parse', '--show-toplevel']);
  directory = await realpath(step('root', top).trim());
  return run;
}

/** Why a candidate is excluded by default: a known credential path, a known secret shape anywhere in its content (symlinks are never followed), or
 * its size. The whole file is scanned (a secret past a prefix must not slip in); the reads are bounded by fileBytes per file and by the
 * default-selection byte limit across files (the caller refuses past it). */
async function flagOf(root: string, path: string, bytes: number, file: boolean): Promise<FirstCommitFlag | null> {
  if (workerTreeDenyForms(path).some(form => denied.some(match => match(form)))) return 'secret-name';
  if (bytes > limits.fileBytes) return 'size';
  if (!file) return null;
  const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(bytes);
    let read = 0;
    for (let part = 1; read < bytes && part > 0;) { part = (await handle.read(buffer, read, bytes - read, read)).bytesRead; read += part; }
    const text = buffer.subarray(0, read).toString('utf8');
    return shapes.some(shape => shape.test(text)) || isConfigFile(path) && configSecretHit(text) ? 'secret-content' : null;
  } finally { await handle.close(); }
}
const digestOf = (paths: readonly string[], message: string) => createHash('sha256').update(JSON.stringify([FIRST_COMMIT_OPERATION_ID, paths, message])).digest('hex');

async function observe(request: Request, git: FirstCommitGit): Promise<Readonly<{ preview: FirstCommitPreview; selection: readonly string[]; message: string }>> {
  const message = request.message.trim();
  if (!message || message.length > limits.messageChars || message.includes('\0')) refuse('SETUP_ANSWER_INVALID');
  const head = await git(gitRegistry.headArgs);
  if (head.code === 0) return { preview: { state: 'has-commits' }, selection: [], message };
  if (head.code !== 1) step('head', head);
  if (step('index', await git(['ls-files', '--cached', '-z'])) !== '') return { preview: { state: 'staged' }, selection: [], message };
  const listed = await git(['ls-files', '--others', '--exclude-standard', '-z'], { outputBytes: limits.files * limits.pathBytes });
  if (listed.overflow) refuse('SETUP_FIRST_COMMIT_TOO_LARGE', { observed: `>${limits.files}`, limit: limits.files });
  const paths = step('list', listed).split('\0').filter(Boolean).sort();
  if (paths.length > limits.files) refuse('SETUP_FIRST_COMMIT_TOO_LARGE', { observed: paths.length, limit: limits.files });
  const root = step('root', await git(['rev-parse', '--show-toplevel'])).trim(), include = new Set(request.include ?? []), rows: FirstCommitRow[] = [];
  let bytes = 0;
  for (const path of paths) {
    // `ls-files` names an untracked nested repository as `dir/`; `update-index --add` would record a gitlink without .gitmodules.
    if (path.endsWith('/')) { rows.push({ path, bytes: 0, flag: 'nested-repository' }); continue; }
    // A candidate that vanished or changed kind after the listing: the repository changed under the preview.
    const info = await lstat(join(root, path)).catch(() => refuse('SETUP_FIRST_COMMIT_CHANGED'));
    const flag = await flagOf(root, path, info.size, info.isFile()).catch(() => refuse('SETUP_FIRST_COMMIT_CHANGED'));
    if (flag !== 'size') bytes += info.size;
    if (bytes > limits.bytes) refuse('SETUP_FIRST_COMMIT_TOO_LARGE', { observed: `>${limits.bytes}`, limit: limits.bytes });
    rows.push({ path, bytes: info.size, flag });
  }
  const selection = rows.filter(row => row.flag === null || row.flag !== 'nested-repository' && include.has(row.path)).map(row => row.path);
  const identity = (await git(['var', 'GIT_AUTHOR_IDENT'])).code === 0 && (await git(['var', 'GIT_COMMITTER_IDENT'])).code === 0;
  const sign = (await git(['config', '--type=bool', '--default=false', '--get', 'commit.gpgSign'])).stdout.trim() === 'true';
  const flagged = rows.filter(row => row.flag !== null), shown = [...flagged, ...rows.filter(row => row.flag === null)].slice(0, limits.previewRows);
  return { preview: { state: 'offered', operation: FIRST_COMMIT_OPERATION_ID, identity, sign, hooks: 'not-run', total: rows.length, selected: selection.length,
    flagged: flagged.length, rows: shown, more: rows.length - shown.length, digest: digestOf(selection, message) }, selection, message };
}

/** Read-only preview of the first commit (U3U4U7 §3.8): offered only for an unborn HEAD with nothing staged; bounded, flagged files excluded. */
export async function previewFirstCommit(request: Request): Promise<FirstCommitPreview> {
  return (await observe(request, request.git ?? await firstCommitGit(request.root, request.env, request.signal))).preview;
}

/**
 * The atomic first commit. Steps 1-5 never touch the real index or HEAD: a temporary index under the Git dir, `write-tree`, `commit-tree`
 * (signing explicit, no hooks). Then Git's lockfile protocol: `index.lock` created exclusively, the real index re-checked empty under it,
 * `update-ref HEAD <commit> <zero>` (fails if the branch appeared), and only then the lock renamed over `index`. Any failure before the ref
 * update leaves HEAD, the index and the worktree as they were (typed error); a failure after it is SETUP_FIRST_COMMIT_INDEX_PENDING with the
 * recovery command. The person-only witness and the audit row belong to the composition owner that binds this operation (U4-1).
 */
export async function applyFirstCommit(request: Request & Readonly<{ digest: string }>): Promise<FirstCommitResult> {
  const git = request.git ?? await firstCommitGit(request.root, request.env, request.signal), seen = await observe(request, git);
  const { preview, selection, message } = seen;
  if (preview.state !== 'offered' || preview.digest !== request.digest) return refuse('SETUP_FIRST_COMMIT_CHANGED');
  const sign = preview.sign;
  if (selection.length === 0) refuse('SETUP_ANSWER_INVALID');
  const gitDir = step('git-dir', await git(['rev-parse', '--absolute-git-dir'])).trim(), index = join(gitDir, 'index'), lock = `${index}.lock`;
  const temporary = join(gitDir, `deckent-first-commit.${randomBytes(8).toString('hex')}.index`);
  const pathsFile = join(gitDir, recoveryNames.paths), receiptFile = join(gitDir, recoveryNames.receipt);
  let held = false, committed = false, refSent = false, pathsOwned = false, receiptOwned = false;
  try {
    step('update-index', await git(['update-index', '--add', '-z', '--stdin'], { input: `${selection.join('\0')}\0`, index: temporary }));
    const tree = step('write-tree', await git(['write-tree'], { index: temporary })).trim();
    const recordedMessage = request.effectKey ? `${message}\n\nDeckent-Effect: ${request.effectKey}` : message;
    const commit = step('commit-tree', await git(['commit-tree', tree, '-m', recordedMessage, sign ? '-S' : '--no-gpg-sign'], { timeoutMs: limits.commitTimeoutMs })).trim();
    // Another Git process holds the lock: nothing is written yet, so this is a changed repository, not a pending index.
    const handle = await open(lock, 'wx').catch((error: NodeJS.ErrnoException) => error.code === 'EEXIST' ? refuse('SETUP_FIRST_COMMIT_CHANGED') : io('index-lock')(error));
    held = true;
    try { await handle.writeFile(await readFile(temporary)); await handle.sync(); } catch (error) { io('index-lock')(error as NodeJS.ErrnoException); } finally { await handle.close(); }
    if (step('index', await git(['ls-files', '--cached', '-z'])) !== '') refuse('SETUP_FIRST_COMMIT_CHANGED');
    const recovery = await inspectFirstCommitRecovery(git, limits.files, limits.pathBytes);
    if (recovery.state === 'prepared') { await rm(receiptFile); await rm(pathsFile); }
    else if (recovery.state !== 'none') refuse('SETUP_FIRST_COMMIT_CHANGED');
    // Retain private committed-path custody before HEAD can move. A crash never needs a whole-index reset.
    const nul = `${selection.join('\0')}\0`, pathsHandle = await open(pathsFile, 'wx', 0o600);
    pathsOwned = true;
    try { await pathsHandle.writeFile(nul); await pathsHandle.sync(); } finally { await pathsHandle.close(); }
    const receiptHandle = await open(receiptFile, 'wx', 0o600); receiptOwned = true;
    try { await receiptHandle.writeFile(JSON.stringify({ schemaVersion: 1, commit, pathsDigest: sha256(nul) })); await receiptHandle.sync(); } finally { await receiptHandle.close(); }
    refSent = true;
    const ref = await git(['update-ref', '-m', `commit (initial): ${message.split('\n')[0]}`, 'HEAD', commit, '0'.repeat(commit.length)]);
    if (ref.code !== 0) {
      const head = await git(gitRegistry.headArgs);
      if (head.code === 0 && head.stdout.trim() !== commit) { refSent = false; refuse('SETUP_FIRST_COMMIT_CHANGED'); }
      if (head.code === 1) refSent = false;
      if (head.code === 0 && head.stdout.trim() === commit) committed = true;
    }
    if (!committed) step('update-ref', ref);
    committed = true;
    await rename(lock, index).catch(() => refuse('SETUP_FIRST_COMMIT_INDEX_PENDING', { command: pathsFile }));
    held = false;
    await rm(receiptFile); receiptOwned = false; await rm(pathsFile); pathsOwned = false;
    return { operation: FIRST_COMMIT_OPERATION_ID, commit, tree, files: selection.length, signed: sign };
  } finally {
    if (held) await rm(lock, { force: true });
    await rm(temporary, { force: true });
    if (!committed && !refSent) { if (receiptOwned) await rm(receiptFile, { force: true }); if (pathsOwned) await rm(pathsFile, { force: true }); }
  }
}

export const observeFirstCommitRecovery = async (root: string, env: DetectEnvironment, signal?: AbortSignal) =>
  inspectFirstCommitRecovery(await firstCommitGit(root, env, signal), limits.files, limits.pathBytes);
