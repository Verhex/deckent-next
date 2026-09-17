import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { workspaceRequestSchema, WorkspaceError, type WorkspaceBroker, type WorkspaceLease, type WorkspaceRequest } from '#engine/index.js';
import format from './format.json' with { type: 'json' };
const exec = promisify(execFile);
const optionsSchema = z.object({ sourceRoot: z.string().min(1), workspaceRoot: z.string().min(1), gitExecutable: z.string().min(1),
  timeoutMs: z.number().int().positive().max(2_147_483_647), outputBytes: z.number().int().positive().safe() }).strict().readonly();
export type GitWorkspaceOptions = z.infer<typeof optionsSchema>;
const recordSchema = z.object({ schemaVersion: z.literal(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  request: workspaceRequestSchema, status: z.enum(['allocating', 'ready']) }).strict();
function code(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? error.code : null; }

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
  private identify(input: WorkspaceRequest) {
    const parsed = workspaceRequestSchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceError('WORKSPACE_REQUEST_INVALID');
    const request = parsed.data;
    const id = createHash('sha256').update(JSON.stringify(request.identity)).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify({ request, options: this.options })).digest('hex');
    const directory = join(this.options.workspaceRoot, id);
    return { request, id, fingerprint, directory, workspace: join(directory, format.checkout), lease: join(directory, format.lease) };
  }
  private async checkedDirectory(path: string) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path) ||
      (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new WorkspaceError('WORKSPACE_UNSAFE');
  }
  private async git(directory: string, args: string[]) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const config = join(directory, format.emptyConfig); const hooks = join(directory, format.hooks);
    try {
      return (await exec(this.options.gitExecutable, ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args],
        { env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0' },
          signal: AbortSignal.timeout(this.options.timeoutMs), maxBuffer: this.options.outputBytes, encoding: 'utf8' })).stdout.trim();
    } catch { throw new WorkspaceError('WORKSPACE_GIT_FAILED'); }
  }
  private async record(lease: string, fingerprint: string) {
    let parsed;
    try {
      const stat = await lstat(lease);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error('unsafe');
      parsed = recordSchema.parse(JSON.parse(await readFile(lease, 'utf8')));
    } catch { throw new WorkspaceError('WORKSPACE_ALLOCATION_INCOMPLETE'); }
    if (parsed.fingerprint !== fingerprint || this.identify(parsed.request).fingerprint !== parsed.fingerprint) throw new WorkspaceError('WORKSPACE_IDENTITY_CONFLICT');
    if (parsed.status !== 'ready') throw new WorkspaceError('WORKSPACE_ALLOCATION_INCOMPLETE');
    return parsed;
  }
  async allocate(input: WorkspaceRequest): Promise<WorkspaceLease> {
    const target = this.identify(input); const o = this.options;
    await this.checkedDirectory(o.sourceRoot); await this.checkedDirectory(o.workspaceRoot);
    let fresh = true;
    try { await mkdir(target.directory, { mode: 0o700 }); }
    catch (error) { if (code(error) !== 'EEXIST') throw error; fresh = false; }
    await this.checkedDirectory(target.directory);
    if (!fresh) {
      await this.record(target.lease, target.fingerprint); await this.checkedDirectory(target.workspace);
    } else {
      const record = { schemaVersion: format.schemaVersion, fingerprint: target.fingerprint, request: target.request, status: 'allocating' };
      await writeFile(target.lease, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await writeFile(join(target.directory, format.emptyConfig), '', { flag: 'wx', mode: 0o600 });
      await mkdir(join(target.directory, format.hooks), { mode: 0o700 });
      const commit = await this.git(target.directory, ['-C', o.sourceRoot, 'rev-parse', '--verify', `${target.request.baseCommit}^{commit}`]);
      if (commit !== target.request.baseCommit) throw new WorkspaceError('WORKSPACE_REQUEST_INVALID');
      await this.git(target.directory, ['clone', '--local', '--no-hardlinks', '--dissociate', '--no-checkout', `--template=${join(target.directory, format.hooks)}`, '--', o.sourceRoot, target.workspace]);
      await this.git(target.directory, ['-C', target.workspace, 'checkout', '--detach', target.request.baseCommit]);
      await this.git(target.directory, ['-C', target.workspace, 'remote', 'remove', 'origin']);
      const checked = await this.git(target.directory, ['-C', target.workspace, 'rev-parse', 'HEAD']);
      if (checked !== target.request.baseCommit) throw new WorkspaceError('WORKSPACE_GIT_FAILED');
      const pending = target.lease + '.pending';
      await writeFile(pending, JSON.stringify({ ...record, status: 'ready' }), { flag: 'wx', mode: 0o600 });
      await rename(pending, target.lease);
    }
    return Object.freeze({ schemaVersion: 1, id: target.id, workspace: target.workspace, baseCommit: target.request.baseCommit, identity: target.request.identity });
  }
  async release(input: WorkspaceRequest): Promise<void> {
    const target = this.identify(input);
    try { await lstat(target.directory); } catch (error) { if (code(error) === 'ENOENT') return; throw error; }
    await this.checkedDirectory(this.options.workspaceRoot); await this.checkedDirectory(target.directory);
    await this.record(target.lease, target.fingerprint);
    await rm(target.directory, { recursive: true });
  }
}
