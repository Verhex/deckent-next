import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, readlink, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerTreeDenyForms } from '#engine/index.js';
import { ErrorRegistry, redactForRecord, callerEnvironment } from '#platform/index.js';
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
/** `offered`: HEAD unborn and nothing staged. Flagged rows come first and are excluded unless named in `include`; `digest` binds the selection,
 * each selected file's mode and the digest of the form Git stores (after its own clean conversion) and the message, so the apply commits exactly
 * the bytes the card showed and scanned. Hooks never run (plumbing); `sign` mirrors the person's commit.gpgSign. */
export type FirstCommitPreview = Readonly<{ state: 'has-commits' }> | Readonly<{ state: 'staged' }> | Readonly<{ state: 'offered'; operation: typeof FIRST_COMMIT_OPERATION_ID;
  identity: boolean; sign: boolean; hooks: 'not-run'; total: number; selected: number; flagged: number; rows: readonly FirstCommitRow[]; more: number; digest: string }>;
export type FirstCommitResult = Readonly<{ operation: typeof FIRST_COMMIT_OPERATION_ID; commit: string; tree: string; files: number; signed: boolean }>;
/** `bytes`: stdout exactly as Git wrote it (blob content is not text). */
export type FirstCommitGitResult = Readonly<{ code: number | null; stdout: string; stderr: string; overflow: boolean; bytes?: Buffer }>;
/** One Git process in the person's environment; `index` is a GIT_INDEX_FILE, `objects` a private GIT_OBJECT_DIRECTORY (a read-only preview never
 * writes the repository's objects). The port the focused test wraps to inject a ref race. */
export type FirstCommitGit = (args: readonly string[], options?: Readonly<{ input?: string | Uint8Array; index?: string; objects?: string; timeoutMs?: number; outputBytes?: number }>) => Promise<FirstCommitGitResult>;
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
  const base = Object.fromEntries(Object.entries(callerEnvironment(env)).filter((entry): entry is [string, string] => entry[1] !== undefined && !policy.stripEnv.includes(entry[0])));
  let directory = root;
  const run: FirstCommitGit = (args, options = {}) => new Promise(done => {
    const child = execFile(executable!, [...gitRegistry.prefix, ...args], { cwd: directory, encoding: 'buffer', timeout: options.timeoutMs ?? detectLimits.commandTimeoutMs,
      maxBuffer: options.outputBytes ?? detectLimits.outputBytes, ...(signal ? { signal } : {}),
      env: { ...base, ...policy.env, ...(options.index ? { GIT_INDEX_FILE: options.index } : {}), ...(options.objects ? { GIT_OBJECT_DIRECTORY: options.objects } : {}) } }, (error, stdout, stderr) => {
      const failure = error as (Error & { code?: unknown; killed?: boolean }) | null, bytes = Buffer.from(stdout ?? '');
      done({ code: !failure ? 0 : typeof failure.code === 'number' && !failure.killed ? failure.code : null, stdout: bytes.toString('utf8'), stderr: Buffer.from(stderr ?? '').toString('utf8'),
        overflow: failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', bytes });
    });
    child.stdin?.on('error', () => undefined); child.stdin?.end(options.input ?? '');
  });
  const top = await run(['rev-parse', '--show-toplevel']);
  directory = await realpath(step('root', top).trim());
  return run;
}
type Candidate = Readonly<{ bytes: Buffer; executable: boolean; link: boolean }>;
type Staged = Readonly<{ mode: '100644' | '100755' | '120000'; digest: string; size: number }>;
/** The bytes of one candidate, read once and never through a link: a regular file's whole content or a symbolic link's target, of exactly the
 * size observed before (checked before anything is allocated, so a file grown past the budget is never read). Any other kind, or a file that
 * changed size meanwhile, throws: the repository changed under the read. */
async function readCandidate(root: string, path: string, expected: number): Promise<Candidate> {
  const full = join(root, path), info = await lstat(full), size = info.size;
  if (size !== expected) throw new Error('changed');
  if (info.isSymbolicLink()) return { bytes: await readlink(full, { encoding: 'buffer' }), executable: false, link: true };
  if (!info.isFile()) throw new Error('kind');
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat(), bytes = Buffer.alloc(size);
    if (!stat.isFile() || stat.size !== size) throw new Error('changed');
    let read = 0;
    for (let part = 1; read < size && part > 0;) { part = (await handle.read(bytes, read, size - read, read)).bytesRead; read += part; }
    if (read !== size || (await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead !== 0) throw new Error('changed');
    return { bytes, executable: (stat.mode & 0o100) !== 0, link: false };
  } finally { await handle.close(); }
}
/** Why a candidate is excluded by default: a known credential path, its size, or a known secret shape anywhere in its whole content. */
const nameOrSize = (path: string, bytes: number): FirstCommitFlag | null =>
  workerTreeDenyForms(path).some(form => denied.some(match => match(form))) ? 'secret-name' : bytes > limits.fileBytes ? 'size' : null;
const secretIn = (path: string, text: string) => shapes.some(shape => shape.test(text)) || isConfigFile(path) && configSecretHit(text);
const digestOf = (staged: ReadonlyMap<string, Staged>, message: string) =>
  createHash('sha256').update(JSON.stringify([FIRST_COMMIT_OPERATION_ID, [...staged].map(([path, file]) => [path, file.mode, file.digest]), message])).digest('hex');
const stagedOf = (file: Candidate, stored: Buffer, fileMode: boolean): Staged =>
  ({ mode: file.link ? '120000' : file.executable && fileMode ? '100755' : '100644', digest: sha256(stored), size: file.bytes.length });
/** Paths whose Git attributes ask for a clean conversion (filter, working-tree-encoding, ident); one read-only `check-attr` for all. */
async function converting(git: FirstCommitGit, paths: readonly string[]): Promise<ReadonlySet<string>> {
  if (!paths.length) return new Set();
  const names = policy.conversionAttributes, fields = step('check-attr', await git(['check-attr', '-z', '--stdin', ...names],
    { input: `${paths.join('\0')}\0`, outputBytes: paths.length * names.length * limits.attributeRowBytes })).split('\0'), found = new Set<string>();
  // `-z` rows are path NUL attribute NUL value NUL.
  for (let row = 0; row < fields.length - 1; row += ROW_FIELDS) if (!['unspecified', 'unset'].includes(fields[row + ROW_FIELDS - 1]!)) found.add(fields[row]!);
  return found;
}
const ROW_FIELDS = ['path', 'attribute', 'value'].length;
/** The form Git stores for a candidate (`git add`'s clean conversion: filter, working-tree-encoding, ident, line endings). Without such an
 * attribute and without a CR byte Git keeps the bytes as they are; otherwise Git converts the bytes this read holds (`hash-object --path`) into
 * the private `objects` directory, never the repository's, and the result is read back. Nothing here is accepted yet. */
async function storedForm(git: FirstCommitGit, path: string, file: Candidate, converts: boolean, objects: string): Promise<Buffer> {
  if (file.link || !converts && !file.bytes.includes('\r')) return file.bytes;
  const blob = step('hash-object', await git(['hash-object', '-w', '--stdin', `--path=${path}`], { input: file.bytes, objects })).trim();
  const read = await git(['cat-file', 'blob', blob], { outputBytes: limits.bytes, objects });
  if (read.overflow) refuse('SETUP_FIRST_COMMIT_TOO_LARGE', { observed: `>${limits.bytes}`, limit: limits.bytes });
  step('cat-file', read);
  return read.bytes ?? Buffer.from(read.stdout);
}
type Observed = Readonly<{ preview: FirstCommitPreview; selection: readonly string[]; message: string; root: string; fileMode: boolean; staged: ReadonlyMap<string, Staged>;
  converts: ReadonlySet<string> }>;
async function observe(request: Request, git: FirstCommitGit, objects: string): Promise<Observed> {
  const message = request.message.trim();
  if (!message || message.length > limits.messageChars || message.includes('\0')) refuse('SETUP_ANSWER_INVALID');
  const head = await git(gitRegistry.headArgs);
  const none = { selection: [], message, root: request.root, fileMode: true, staged: new Map<string, Staged>(), converts: new Set<string>() };
  if (head.code === 0) return { preview: { state: 'has-commits' }, ...none };
  if (head.code !== 1) step('head', head);
  if (step('index', await git(['ls-files', '--cached', '-z'])) !== '') return { preview: { state: 'staged' }, ...none };
  const listed = await git(['ls-files', '--others', '--exclude-standard', '-z'], { outputBytes: limits.files * limits.pathBytes });
  if (listed.overflow) refuse('SETUP_FIRST_COMMIT_TOO_LARGE', { observed: `>${limits.files}`, limit: limits.files });
  const paths = step('list', listed).split('\0').filter(Boolean).sort();
  if (paths.length > limits.files) refuse('SETUP_FIRST_COMMIT_TOO_LARGE', { observed: paths.length, limit: limits.files });
  const root = step('root', await git(['rev-parse', '--show-toplevel'])).trim(), include = new Set(request.include ?? []), rows: FirstCommitRow[] = [];
  // Git's own rule for a new file's mode: the executable bit counts only while core.fileMode is on.
  const fileMode = (await git(['config', '--type=bool', '--default=true', '--get', 'core.fileMode'])).stdout.trim() !== 'false', staged = new Map<string, Staged>();
  const converts = await converting(git, paths.filter(path => !path.endsWith('/')));
  let bytes = 0;
  for (const path of paths) {
    // `ls-files` names an untracked nested repository as `dir/`; staging it would record a gitlink without .gitmodules.
    if (path.endsWith('/')) { rows.push({ path, bytes: 0, flag: 'nested-repository' }); continue; }
    // A candidate that vanished or changed kind after the listing: the repository changed under the preview.
    const info = await lstat(join(root, path)).catch(() => refuse('SETUP_FIRST_COMMIT_CHANGED'));
    const early = nameOrSize(path, info.size), selected = early === null || include.has(path);
    // Every file read is bounded: the default selection, any file the person ticks, and the content scan of the rest.
    if (early !== 'size' || selected) bytes += info.size;
    if (bytes > limits.bytes) refuse('SETUP_FIRST_COMMIT_TOO_LARGE', { observed: `>${limits.bytes}`, limit: limits.bytes });
    const file = early === null || selected ? await readCandidate(root, path, info.size).catch(() => refuse('SETUP_FIRST_COMMIT_CHANGED')) : null;
    // The scan reads both the work-tree bytes and the form Git stores: an encoding or a clean filter can turn one into a secret.
    const stored = file ? await storedForm(git, path, file, converts.has(path), objects) : null;
    const flag = early ?? (file && !file.link && (secretIn(path, file.bytes.toString('utf8')) || secretIn(path, stored!.toString('utf8'))) ? 'secret-content' : null);
    if (file && (flag === null || include.has(path))) staged.set(path, stagedOf(file, stored!, fileMode));
    rows.push({ path, bytes: info.size, flag });
  }
  const selection = [...staged.keys()];
  const identity = (await git(['var', 'GIT_AUTHOR_IDENT'])).code === 0 && (await git(['var', 'GIT_COMMITTER_IDENT'])).code === 0;
  const sign = (await git(['config', '--type=bool', '--default=false', '--get', 'commit.gpgSign'])).stdout.trim() === 'true';
  const flagged = rows.filter(row => row.flag !== null), shown = [...flagged, ...rows.filter(row => row.flag === null)].slice(0, limits.previewRows);
  return { preview: { state: 'offered', operation: FIRST_COMMIT_OPERATION_ID, identity, sign, hooks: 'not-run', total: rows.length, selected: selection.length,
    flagged: flagged.length, rows: shown, more: rows.length - shown.length, digest: digestOf(staged, message) }, selection, message, root, fileMode, staged, converts };
}
/** A private object directory for the stored-form reads of an observation, removed afterwards: observing never writes the repository. */
async function scratchObjects<T>(work: (objects: string) => Promise<T>): Promise<T> {
  const objects = await mkdtemp(join(tmpdir(), 'deckent-first-commit-objects-'));
  try { return await work(objects); } finally { await rm(objects, { recursive: true, force: true }); }
}
/** Read-only preview of the first commit (U3U4U7 §3.8): offered only for an unborn HEAD with nothing staged; bounded, flagged files excluded. */
export async function previewFirstCommit(request: Request): Promise<FirstCommitPreview> {
  const git = request.git ?? await firstCommitGit(request.root, request.env, request.signal);
  return (await scratchObjects(objects => observe(request, git, objects))).preview;
}
/**
 * The atomic first commit. Steps 1-5 never touch the real index or HEAD: a temporary index under the Git dir, `write-tree`, `commit-tree`
 * (signing explicit, no hooks). Then Git's lockfile protocol: `index.lock` created exclusively, the real index re-checked empty under it,
 * `update-ref HEAD <commit> <zero>` (fails if the branch appeared), and only then the lock renamed over `index`. Any failure before the ref
 * update leaves HEAD, the index and the worktree as they were (typed error); a failure after it is SETUP_FIRST_COMMIT_INDEX_PENDING with the
 * recovery command. The person-only witness and the audit row belong to the composition owner that binds this operation (U4-1).
 */
export async function applyFirstCommit(request: Request & Readonly<{ digest: string }>): Promise<FirstCommitResult> {
  const git = request.git ?? await firstCommitGit(request.root, request.env, request.signal), seen = await scratchObjects(objects => observe(request, git, objects));
  const { preview, selection, message, root, fileMode, staged, converts } = seen;
  if (preview.state !== 'offered' || preview.digest !== request.digest) return refuse('SETUP_FIRST_COMMIT_CHANGED');
  const sign = preview.sign;
  if (selection.length === 0) refuse('SETUP_ANSWER_INVALID');
  const gitDir = step('git-dir', await git(['rev-parse', '--absolute-git-dir'])).trim(), index = join(gitDir, 'index'), lock = `${index}.lock`;
  const temporary = join(gitDir, `deckent-first-commit.${randomBytes(8).toString('hex')}.index`);
  const pathsFile = join(gitDir, recoveryNames.paths), receiptFile = join(gitDir, recoveryNames.receipt);
  let held = false, committed = false, refSent = false, pathsOwned = false, receiptOwned = false;
  try {
    // Git stores exactly the form this apply scanned, never a later read of the work tree: each file is read again (its observed size first),
    // its stored form is produced in a private object directory and must equal the scanned digest and mode; only then are those exact bytes
    // written into the repository, without filters. A refused form never reaches the repository's objects.
    const entries = await scratchObjects(async objects => {
      const rows: string[] = [];
      for (const path of selection) {
        const want = staged.get(path)!, file = await readCandidate(root, path, want.size).catch(() => refuse('SETUP_FIRST_COMMIT_CHANGED'));
        const stored = await storedForm(git, path, file, converts.has(path), objects), now = stagedOf(file, stored, fileMode);
        if (now.mode !== want.mode || now.digest !== want.digest) refuse('SETUP_FIRST_COMMIT_CHANGED');
        rows.push(`${want.mode} ${step('hash-object', await git(['hash-object', '-w', '--no-filters', '--stdin'], { input: stored })).trim()}\t${path}\0`);
      }
      return rows;
    });
    step('update-index', await git(['update-index', '-z', '--index-info'], { input: entries.join(''), index: temporary }));
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
