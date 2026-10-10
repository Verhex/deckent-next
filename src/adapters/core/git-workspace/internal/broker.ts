import { GIT_EXECUTION_SETTINGS } from '#platform/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { workspaceRequestSchema, WorkspaceError, type WorkspaceBroker, type WorkspaceLease, type WorkspaceRequest } from '#engine/index.js';
import format from './format.json' with { type: 'json' };
import { fingerprintGitSource, gitSourceBaseSchema, gitSourcePreimageSchema, type GitSourceBase } from './source-base.js';
const exec = promisify(execFile);
const SOURCE_BASE_NAME = new RegExp(`^${format.sourceBase.replace('.', '\\.')}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);
/** `baseRef` (WORK-TARGETS): a configured work target's base branch. Present, a Run's base is its tip and delivery/integration compare
 * against it; absent, the source checkout's HEAD as before (the option is then not part of any fingerprint). */
const optionsSchema = GIT_EXECUTION_SETTINGS.extend({ sourceRoot: z.string().min(1), workspaceRoot: z.string().min(1),
  baseRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/).optional() }).strict().readonly();
export type GitWorkspaceOptions = z.infer<typeof optionsSchema>;
const recordSchema = z.object({ schemaVersion: z.literal(2), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  request: workspaceRequestSchema, sourceBase: gitSourceBaseSchema, status: z.enum(['allocating', 'ready']) }).strict();
export interface GitWorkspaceLease extends WorkspaceLease { readonly sourceBase: GitSourceBase }
function code(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? error.code : null; }
/** Lease records are custody evidence: file data and the directory entry are flushed before the step that relies on them. */
async function syncPath(path: string, directory = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0));
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeDurable(path: string, data: string) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

/** Independent Git checkout: private metadata and copied objects, no shared writable .git or hardlinks.
 * Trusted host allocation only; worker access is separately confined by the execution sandbox.
 */
export class GitWorkspaceBroker implements WorkspaceBroker {
  private readonly options: GitWorkspaceOptions;
  constructor(input: GitWorkspaceOptions) {
    const parsed = optionsSchema.safeParse(input);
    if (!parsed.success || ![parsed.data.sourceRoot, parsed.data.workspaceRoot, parsed.data.gitExecutable].every(isAbsolute)) throw new WorkspaceError('WORKSPACE_OPTIONS_INVALID');
    this.options = parsed.data;
  }
  private identityTarget(input: unknown) {
    const identity = attemptIdentitySchema.safeParse(input);
    if (!identity.success) throw new WorkspaceError('WORKSPACE_REQUEST_INVALID');
    const id = createHash('sha256').update(JSON.stringify(identity.data)).digest('hex');
    const directory = join(this.options.workspaceRoot, id);
    return { identity: identity.data, id, directory, workspace: join(directory, format.checkout), lease: join(directory, format.lease) };
  }
  private identify(input: WorkspaceRequest) {
    const parsed = workspaceRequestSchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceError('WORKSPACE_REQUEST_INVALID');
    const request = parsed.data;
    const { id, directory, workspace, lease } = this.identityTarget(request.identity);
    return { request, id, directory, workspace, lease };
  }
  private fingerprint(request: WorkspaceRequest, sourceBase: GitSourceBase) {
    return createHash('sha256').update(JSON.stringify({ request, sourceBase, options: this.options })).digest('hex');
  }
  private validSourceBase(sourceBase: GitSourceBase, request: WorkspaceRequest) {
    return fingerprintGitSource(sourceBase.source) === sourceBase.sourceFingerprint && sourceBase.baseCommit === request.baseCommit
      && [sourceBase.source.sourceRoot, sourceBase.source.repositoryRoot].every(path => isAbsolute(path) && resolve(path) === path);
  }
  private async checkedDirectory(path: string) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path) ||
      (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new WorkspaceError('WORKSPACE_UNSAFE');
  }
  /** `noLazyFetch` is set only for the pre-clone `rev-parse` calls against the caller's real `sourceRoot` in
   * `currentSource()`/`allocate()`: unlike the later `clone --local`/`checkout`/`remote remove` calls, which
   * run against a Deckent-owned workspace and must keep exactly today's `protocol.file.allow=always` local
   * clone behavior, these read the caller's own repository and gain the same promisor-lazy-fetch backstop the
   * git-patch package's shared construction uses (`GIT_NO_LAZY_FETCH=1`; proof/GIT-NET-2026-09-29/review.md). */
  private async git(directory: string, args: string[], noLazyFetch = false) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const config = join(directory, format.emptyConfig); const hooks = join(directory, format.hooks);
    try {
      return (await exec(this.options.gitExecutable, ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args],
        { env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0', ...(noLazyFetch ? { GIT_NO_LAZY_FETCH: '1' } : {}) },
          signal: AbortSignal.timeout(this.options.timeoutMs), maxBuffer: this.options.outputBytes, encoding: 'utf8' })).stdout.trim();
    } catch { throw new WorkspaceError('WORKSPACE_GIT_FAILED'); }
  }
  private async readRecord(lease: string, allocating = false) {
    let parsed; let value: unknown;
    try {
      const stat = await lstat(lease);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe');
      value = JSON.parse(await readFile(lease, 'utf8'));
      if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 1) throw new WorkspaceError('WORKSPACE_CUSTODY_UNCONVERTIBLE');
      parsed = recordSchema.parse(value);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError('WORKSPACE_ALLOCATION_INCOMPLETE');
    }
    if (parsed.status !== 'ready' && !allocating) throw new WorkspaceError('WORKSPACE_ALLOCATION_INCOMPLETE');
    return parsed;
  }
  private async record(lease: string, request: WorkspaceRequest, allocating = false) {
    const parsed = await this.readRecord(lease, allocating);
    if (JSON.stringify(parsed.request) !== JSON.stringify(request) || parsed.fingerprint !== this.fingerprint(parsed.request, parsed.sourceBase)
      || !this.validSourceBase(parsed.sourceBase, parsed.request)) throw new WorkspaceError('WORKSPACE_IDENTITY_CONFLICT');
    return parsed;
  }
  async openRecorded(identityInput: AttemptIdentity): Promise<GitWorkspaceLease | null> {
    const target = this.identityTarget(identityInput);
    await this.checkedDirectory(this.options.workspaceRoot);
    try { await lstat(target.directory); }
    catch (error) { if (code(error) === 'ENOENT') return null; throw error; }
    await this.checkedDirectory(target.directory);
    const candidate = await this.readRecord(target.lease); const recordedTarget = this.identify(candidate.request);
    if (recordedTarget.id !== target.id || candidate.fingerprint !== this.fingerprint(candidate.request, candidate.sourceBase)
      || !this.validSourceBase(candidate.sourceBase, candidate.request)
      || JSON.stringify(candidate.request.identity) !== JSON.stringify(target.identity)) throw new WorkspaceError('WORKSPACE_IDENTITY_CONFLICT');
    try { await this.checkedDirectory(target.workspace); }
    catch { throw new WorkspaceError('WORKSPACE_ALLOCATION_INCOMPLETE'); }
    return Object.freeze({ schemaVersion: 1, id: target.id, workspace: target.workspace,
      baseCommit: candidate.request.baseCommit, identity: candidate.request.identity, sourceBase: candidate.sourceBase });
  }
  private async currentSource(explicitCommit?: string): Promise<GitSourceBase> {
    if (explicitCommit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(explicitCommit)) throw new WorkspaceError('WORKSPACE_REQUEST_INVALID');
    await this.checkedDirectory(this.options.sourceRoot); await this.checkedDirectory(this.options.workspaceRoot);
    const temporary = join(this.options.workspaceRoot, `${format.sourceBase}${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await writeFile(join(temporary, format.emptyConfig), '', { flag: 'wx', mode: 0o600 });
      await mkdir(join(temporary, format.hooks), { mode: 0o700 });
      const canonicalSource = await realpath(this.options.sourceRoot);
      const repository = await this.git(temporary, ['-C', canonicalSource, 'rev-parse', '--show-toplevel'], true);
      const canonicalRepository = await realpath(repository);
      await this.checkedDirectory(canonicalRepository);
      const source = gitSourcePreimageSchema.parse({ schemaVersion: 1, sourceRoot: canonicalSource, repositoryRoot: canonicalRepository });
      const revision = explicitCommit === undefined ? `${this.options.baseRef ?? 'HEAD'}^{commit}` : `${explicitCommit}^{commit}`;
      const commit = await this.git(temporary, ['-C', canonicalSource, 'rev-parse', '--verify', revision], true);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new WorkspaceError('WORKSPACE_GIT_FAILED');
      if (explicitCommit !== undefined && commit !== explicitCommit) throw new WorkspaceError('WORKSPACE_REQUEST_INVALID');
      return gitSourceBaseSchema.parse({ schemaVersion: 1, adapter: { id: 'git', version: 1 },
        sourceFingerprint: fingerprintGitSource(source), source, baseCommit: commit });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async captureSourceBase(explicitCommit?: string): Promise<GitSourceBase> { return this.currentSource(explicitCommit); }
  async assertSourceBase(input: GitSourceBase): Promise<GitSourceBase> {
    const recorded = gitSourceBaseSchema.parse(input); const current = await this.currentSource(recorded.baseCommit);
    if (JSON.stringify(current) !== JSON.stringify(recorded)) throw new WorkspaceError('WORKSPACE_IDENTITY_CONFLICT');
    return recorded;
  }
  async allocate(input: WorkspaceRequest): Promise<GitWorkspaceLease> {
    const target = this.identify(input); const o = this.options;
    await this.checkedDirectory(o.sourceRoot); await this.checkedDirectory(o.workspaceRoot);
    let fresh = true;
    try { await mkdir(target.directory, { mode: 0o700 }); }
    catch (error) { if (code(error) !== 'EEXIST') throw error; fresh = false; }
    await this.checkedDirectory(target.directory);
    let sourceBase: GitSourceBase;
    if (!fresh) {
      const recorded = await this.record(target.lease, target.request); sourceBase = await this.assertSourceBase(recorded.sourceBase);
      await this.checkedDirectory(target.workspace);
    } else {
      sourceBase = await this.captureSourceBase(target.request.baseCommit);
      const record = { schemaVersion: format.schemaVersion, fingerprint: this.fingerprint(target.request, sourceBase), request: target.request, sourceBase, status: 'allocating' };
      await writeDurable(target.lease, JSON.stringify(record)); await syncPath(target.directory, true); await syncPath(o.workspaceRoot, true);
      await writeFile(join(target.directory, format.emptyConfig), '', { flag: 'wx', mode: 0o600 });
      await mkdir(join(target.directory, format.hooks), { mode: 0o700 });
      const commit = await this.git(target.directory, ['-C', o.sourceRoot, 'rev-parse', '--verify', `${target.request.baseCommit}^{commit}`], true);
      if (commit !== target.request.baseCommit) throw new WorkspaceError('WORKSPACE_REQUEST_INVALID');
      await this.git(target.directory, ['clone', '--local', '--no-hardlinks', '--dissociate', '--no-checkout', `--template=${join(target.directory, format.hooks)}`, '--', o.sourceRoot, target.workspace]);
      await this.git(target.directory, ['-C', target.workspace, 'checkout', '--detach', target.request.baseCommit]);
      // Git's directory modes inherit the process umask; secure only this fresh clone before publishing its lease.
      const gitDirectory = await this.git(target.directory, ['-C', target.workspace, 'rev-parse', '--absolute-git-dir']);
      for (const path of [target.workspace, gitDirectory]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path) ||
          (process.getuid && stat.uid !== process.getuid())) throw new WorkspaceError('WORKSPACE_UNSAFE');
        await chmod(path, stat.mode & ~0o022);
      }
      await this.git(target.directory, ['-C', target.workspace, 'remote', 'remove', 'origin']);
      const checked = await this.git(target.directory, ['-C', target.workspace, 'rev-parse', 'HEAD']);
      if (checked !== target.request.baseCommit) throw new WorkspaceError('WORKSPACE_GIT_FAILED');
      const pending = target.lease + '.pending';
      await writeDurable(pending, JSON.stringify({ ...record, status: 'ready' }));
      await rename(pending, target.lease); await syncPath(target.directory, true);
    }
    const recorded = await this.record(target.lease, target.request);
    if (JSON.stringify(recorded.sourceBase) !== JSON.stringify(sourceBase)) throw new WorkspaceError('WORKSPACE_IDENTITY_CONFLICT');
    return Object.freeze({ schemaVersion: 1, id: target.id, workspace: target.workspace, baseCommit: target.request.baseCommit,
      identity: target.request.identity, sourceBase: recorded.sourceBase });
  }
  async release(input: WorkspaceRequest, allocating = false): Promise<'removed' | 'absent'> {
    const target = this.identify(input);
    try { await lstat(target.directory); } catch (error) { if (code(error) === 'ENOENT') return 'absent'; throw error; }
    await this.checkedDirectory(this.options.workspaceRoot); await this.checkedDirectory(target.directory);
    await this.record(target.lease, target.request, allocating);
    // Detach first (rename(2) in the same root is atomic): readers see the clone absent at once. The detached name carries this attempt's
    // directory id and keeps its lease, so only this exact attempt's later authorized release can verify and finish an interrupted removal.
    const detached = join(this.options.workspaceRoot, `${format.detached}${target.id}-${randomUUID()}`);
    await rename(target.directory, detached); await syncPath(this.options.workspaceRoot, true);
    await this.removeDetached(detached);
    return 'removed';
  }
  /** Checkout and sidecars first, the lease last: an interruption at any point leaves a detached directory that still proves its attempt. */
  private async removeDetached(path: string) {
    for (const name of await readdir(path)) if (name !== format.lease) await rm(join(path, name), { recursive: true });
    await rm(join(path, format.lease)); await rm(path, { recursive: true });
  }
  private async detachedOf(id: string) {
    return (await readdir(this.options.workspaceRoot)).filter(name => name.startsWith(`${format.detached}${id}-`)).slice(0, 8);
  }
  /** EXEC-RELEASE: called only with ledger proof (terminal attempt, verified retained patch) and `attempt:release` authority for this exact
   * record. `workspace` must be this identity's own checkout; the same exact request's 'allocating' record (a 'ready' rename an older build
   * lost in a crash) is then removable too. It also finishes this attempt's own interrupted detach (Sol ER-R2): each detached directory must
   * be private, owned and hold this exact request's lease; anything unverifiable is kept and refused as `WORKSPACE_IDENTITY_CONFLICT`. */
  async releaseAttempt(request: WorkspaceRequest, workspace: string): Promise<'removed' | 'absent'> {
    const target = this.identify(request);
    if (target.workspace !== workspace) throw new WorkspaceError('WORKSPACE_IDENTITY_CONFLICT');
    let result = await this.release(request, true), unverified = 0;
    for (const name of await this.detachedOf(target.id)) {
      const path = join(this.options.workspaceRoot, name);
      try { await this.checkedDirectory(path); await this.record(join(path, format.lease), target.request, true); }
      catch { unverified++; continue; }
      await this.removeDetached(path); result = 'removed';
    }
    if (unverified) throw new WorkspaceError('WORKSPACE_IDENTITY_CONFLICT');
    return result;
  }
  /** Whether the attempt directory or its own detached removal still exists; a work filter only, never release eligibility (the ledger). */
  async holds(identity: AttemptIdentity): Promise<boolean> {
    const target = this.identityTarget(identity);
    try { await lstat(target.directory); return true; } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    return (await this.detachedOf(target.id)).length > 0;
  }
  /** EXEC-RELEASE C3: a crash between creating a source-base probe and its `finally` removal leaves `.base-<uuid>` in the shared root.
   * Only probes this broker provably created are removed: the exact name, a private directory owned by this uid holding nothing but its
   * empty Git config file and an empty hooks directory, unchanged for longer than a probe can live (it makes two Git calls, each bounded by
   * `timeoutMs`; the derived bound is `format.sourceBaseStaleAfterGitTimeouts` × `timeoutMs`). Anything else (foreign, symlink, extra content, younger) is kept and counted.
   * Removal is exact (file, hooks directory, directory), never recursive: a concurrent addition makes `rmdir` fail and keeps it. */
  async sweepSourceBases(limit: number): Promise<Readonly<{ removed: number; kept: number }>> {
    const root = this.options.workspaceRoot; await this.checkedDirectory(root);
    const staleBefore = Date.now() - format.sourceBaseStaleAfterGitTimeouts * this.options.timeoutMs; let removed = 0, kept = 0;
    for (const name of await readdir(root)) {
      if (!name.startsWith(format.sourceBase)) continue;
      if (removed < limit && await this.removeSourceBase(root, name, staleBefore)) removed++; else kept++;
    }
    return Object.freeze({ removed, kept });
  }
  private async removeSourceBase(root: string, name: string, staleBefore: number): Promise<boolean> {
    if (!SOURCE_BASE_NAME.test(name)) return false;
    const path = join(root, name), config = join(path, format.emptyConfig), hooks = join(path, format.hooks);
    const owned = (stat: { uid: number }) => !process.getuid || stat.uid === process.getuid();
    try {
      await this.checkedDirectory(path); const stat = await lstat(path);
      if ((stat.mode & 0o077) !== 0) return false;
      if (stat.mtimeMs > staleBefore) return false;
      const names = await readdir(path);
      if (names.some(entry => entry !== format.emptyConfig && entry !== format.hooks)) return false;
      if (names.includes(format.emptyConfig)) {
        const file = await lstat(config); if (!file.isFile() || file.size !== 0 || file.nlink !== 1 || !owned(file)) return false;
      }
      if (names.includes(format.hooks)) {
        const directory = await lstat(hooks); if (!directory.isDirectory() || !owned(directory) || (await readdir(hooks)).length) return false;
      }
      if (names.includes(format.emptyConfig)) await rm(config);
      if (names.includes(format.hooks)) await rmdir(hooks);
      await rmdir(path); return true;
    } catch { return false; }
  }
  /** Detached removals left in the shared root (any attempt, any scope); counted for visibility, never removed here. */
  async countDetached(): Promise<number> {
    return (await readdir(this.options.workspaceRoot)).filter(name => name.startsWith(format.detached)).length;
  }
}
