import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { sandboxRequestSchema, SupervisorError, type SandboxRequest, type SandboxResult, type ExecutionSupervisor } from '#engine/index.js';
import { dockerSupervisorOptionsSchema, type DockerSupervisorOptions } from './options.js';
const exec = promisify(execFile);
type Inspection = { Config: { Labels: Record<string, string> }; State: { Status: string; ExitCode: number } };
/** Containers remain as reconciliation evidence until the application explicitly releases them.
 * Only an application with durable dispatch ownership may call execute; this adapter does not grant policy.
 */
export class DockerSupervisor implements ExecutionSupervisor {
  private readonly options: DockerSupervisorOptions;
  constructor(input: DockerSupervisorOptions) {
    const parsed = dockerSupervisorOptionsSchema.safeParse(input);
    if (!parsed.success || !isAbsolute(parsed.data.workspaceRoot) || !isAbsolute(parsed.data.executable)) throw new SupervisorError('SUPERVISOR_OPTIONS_INVALID');
    this.options = parsed.data;
  }
  private async command(args: string[], timeout: number, signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(timeout);
    return exec(this.options.executable, args, { maxBuffer: this.options.outputBytes, encoding: 'utf8',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  }
  private identity(request: SandboxRequest) {
    const parsed = sandboxRequestSchema.safeParse(request);
    if (!parsed.success || parsed.data.argv.some(value => value.includes('\0'))) throw new SupervisorError('SUPERVISOR_REQUEST_INVALID');
    const digest = createHash('sha256').update(JSON.stringify({ request: parsed.data, options: this.options })).digest('hex');
    const handle = 'deckent-' + createHash('sha256').update(JSON.stringify(parsed.data.identity)).digest('hex');
    return { request: parsed.data, digest, handle };
  }
  private async inspect(handle: string, digest: string): Promise<Inspection | null> {
    let stdout: string;
    try { stdout = (await this.command(['inspect', handle], this.options.controlTimeoutMs)).stdout; }
    catch (error) {
      // Only Docker's explicit missing-object response means absent; daemon/permission errors stay unknown.
      if (error && typeof error === 'object' && 'stderr' in error && String(error.stderr).toLowerCase().includes('no such object: ' + handle)) return null;
      throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    }
    let value: Inspection;
    try { value = JSON.parse(stdout)[0] as Inspection; }
    catch { throw new SupervisorError('SUPERVISOR_CONTROL_FAILED'); }
    if (value?.Config?.Labels?.['deckent.request'] !== digest) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
    return value;
  }
  private result(handle: string, inspection: Inspection | null, stdout = '', stderr = '', interrupted = false): SandboxResult {
    const result = inspection?.State?.Status === 'exited' && Number.isSafeInteger(inspection.State.ExitCode)
      ? { kind: 'exited' as const, exitCode: inspection.State.ExitCode }
      : { kind: 'unknown' as const, reasonCode: 'SUPERVISOR_OUTCOME_UNRESOLVED' };
    return Object.freeze({ handle, result: Object.freeze(result), stdout, stderr, interrupted });
  }
  async observe(input: SandboxRequest): Promise<Pick<SandboxResult, 'handle' | 'result'>> {
    const { digest, handle } = this.identity(input);
    const observed = this.result(handle, await this.inspect(handle, digest));
    return Object.freeze({ handle: observed.handle, result: observed.result });
  }
  async execute(input: SandboxRequest, signal?: AbortSignal): Promise<SandboxResult> {
    const { request, digest, handle } = this.identity(input);
    if (signal?.aborted) throw new SupervisorError('SUPERVISOR_CANCELLED');
    const root = resolve(this.options.workspaceRoot); const workspace = resolve(request.workspace); const path = relative(root, workspace);
    if (!isAbsolute(request.workspace) || !path || path === '..' || path.startsWith('..' + sep) || workspace.includes(',') ||
      await realpath(root) !== root || await realpath(workspace) !== workspace || !(await stat(workspace)).isDirectory()) {
      throw new SupervisorError('SUPERVISOR_WORKSPACE_INVALID');
    }
    const previous = await this.inspect(handle, digest);
    if (previous) return this.result(handle, previous);
    const o = this.options;
    try {
      await this.command(['create', '--name', handle, '--label', 'deckent.request=' + digest,
        '--network', 'none', '--log-driver', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', String(o.pids), '--memory', String(o.memoryBytes), '--memory-swap', String(o.memoryBytes), '--cpus', String(o.cpus),
        '--ipc', 'private', '--cgroupns', 'private', '--user', `${o.uid}:${o.gid}`,
        '--mount', `type=bind,src=${workspace},dst=/workspace`, '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${o.tmpBytes}`,
        '--workdir', '/workspace', '--entrypoint', request.argv[0]!, o.imageId, ...request.argv.slice(1)], o.controlTimeoutMs);
    } catch {
      const existing = await this.inspect(handle, digest);
      if (existing) return this.result(handle, existing);
      throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    }
    let stdout: string; let stderr: string; let interrupted = false;
    try {
      const output = await this.command(['start', '--attach', handle], o.deadlineMs, signal);
      stdout = output.stdout; stderr = output.stderr;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; killed?: boolean; code?: unknown };
      stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
      stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
      interrupted = !!signal?.aborted || !!failure.killed || typeof failure.code !== 'number';
      const observed = await this.inspect(handle, digest);
      if (observed?.State.Status === 'exited') return this.result(handle, observed, stdout, stderr, interrupted);
      interrupted = true;
      // An interrupted CLI is not proof the container stopped. Kill, then inspect authoritative daemon state.
      try { await this.command(['kill', handle], o.controlTimeoutMs); } catch { /* Inspect determines terminal truth. */ }
    }
    return this.result(handle, await this.inspect(handle, digest), stdout, stderr, interrupted);
  }
  async release(input: SandboxRequest): Promise<void> {
    const { digest, handle } = this.identity(input); const existing = await this.inspect(handle, digest);
    if (!existing) return;
    if (existing.State.Status !== 'exited') throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
    try { await this.command(['rm', handle], this.options.controlTimeoutMs); }
    catch { throw new SupervisorError('SUPERVISOR_CONTROL_FAILED'); }
  }
}
