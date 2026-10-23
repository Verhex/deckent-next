import { collectDockerOutputFiles } from './output-files.js';
import { sampleDockerResources } from './resources.js';
import { captureDockerProfile, readDockerProfile, dockerEndpointSchema } from './profile.js';
import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { workerIncarnationSchema, containerEvidenceSchema, SupervisorError, sandboxInterruptCause, type SandboxRequest, type SandboxResult, type ExecutionSupervisor, type SupervisorLaunchHooks } from '#engine/index.js';
import { dockerSupervisorOptionsSchema, type DockerSupervisorOptions } from './options.js';
import { identifyDockerRequest } from './identity.js';
import { runNodeDockerCommand, DockerCommandFailure, type DockerCommandRunner } from './command.js';
import { dockerConnectionMounts } from './connection.js';
import { assertDockerMountsMatch, assertReadOnlyMountSource, type DockerExpectedMount } from './mounts.js';
import { dockerNodeHeapEnvironment } from './node-heap.js';
/** `docker run`'s own exit status when the daemon could not create or start the container (not the probe's answer). */
const DOCKER_RUN_DAEMON_FAILURE = 125;
/** The only container names a probe removal may touch (probeIdentity's form). */
const PREFLIGHT_PROBE_NAME = /^deckent-env-[a-f0-9]{64}$/;
type Inspection = { Id: string; Image: string; Config: { Labels: Record<string, string> }; Mounts?: unknown; State: { Status: string; ExitCode: number; StartedAt?: unknown; FinishedAt?: unknown } };
/** Containers remain as reconciliation evidence until the application explicitly releases them.
 * Only an application with durable dispatch ownership may call execute; this adapter does not grant policy.
 */
export class DockerSupervisor implements ExecutionSupervisor {
  private readonly options: DockerSupervisorOptions;
  private endpoint?: Promise<string>;
  constructor(input: DockerSupervisorOptions, private readonly runner: DockerCommandRunner = runNodeDockerCommand) {
    const parsed = dockerSupervisorOptionsSchema.safeParse(input);
    if (!parsed.success || !isAbsolute(parsed.data.workspaceRoot) || !isAbsolute(parsed.data.executable)) throw new SupervisorError('SUPERVISOR_OPTIONS_INVALID');
    this.options = parsed.data;
  }
  private async daemonId(): Promise<string> {
    const value = (await this.command(['info', '--format', '{{.ID}}'], this.options.controlTimeoutMs)).stdout.trim();
    if (!value) throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    return value;
  }
  /** Capture resolved adapter settings, not current policy. Contains no secret values. */
  async captureProfile() { return captureDockerProfile(this.options, await this.daemonId(), await this.resolveEndpoint()); }
  static async restoreProfile(input: unknown, runner: DockerCommandRunner = runNodeDockerCommand) {
    const { options, origin, endpoint } = readDockerProfile(input);
    const supervisor = new DockerSupervisor(options, runner);
    supervisor.endpoint = Promise.resolve(endpoint);
    if (await supervisor.daemonId() !== origin.daemonId) throw new SupervisorError('SUPERVISOR_PROFILE_ORIGIN_MISMATCH');
    return supervisor;
  }
  private resolveEndpoint(): Promise<string> {
    return this.endpoint ??= this.runner({ executable: this.options.executable,
      args: ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'],
      timeoutMs: this.options.controlTimeoutMs, outputBytes: this.options.outputBytes,
    }).then(output => {
      try { return dockerEndpointSchema.parse(JSON.parse(output.stdout).Host); }
      catch { throw new SupervisorError('SUPERVISOR_PROFILE_INVALID'); }
    });
  }
  private async command(args: string[], timeout: number, signal?: AbortSignal) {
    return this.runner({ executable: this.options.executable, args: ['--host', await this.resolveEndpoint(), ...args], timeoutMs: timeout, outputBytes: this.options.outputBytes }, signal);
  }
  private identity(request: SandboxRequest) { return identifyDockerRequest(request, this.options); }
  async readResources(request: SandboxRequest, expected: import('#domain/index.js').WorkerIncarnation | null,
    settings: import('#platform/index.js').ResourceObservationSettings, signal: AbortSignal) {
    const { handle, digest } = this.identity(request);
    return sampleDockerResources(await this.resolveEndpoint(), request, handle, digest, expected, settings, signal);
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
  private result(handle: string, inspection: Inspection | null, stdout = '', stderr = '', interrupted = false, captured = false, cause?: SandboxResult['interruptCause']): SandboxResult {
    const result = inspection?.State?.Status === 'exited' && Number.isSafeInteger(inspection.State.ExitCode)
      ? { kind: 'exited' as const, exitCode: inspection.State.ExitCode }
      : { kind: 'unknown' as const, reasonCode: 'SUPERVISOR_OUTCOME_UNRESOLVED' };
    let container: SandboxResult['container'];
    if (inspection && result.kind === 'exited') {
      const time = (value: unknown) => typeof value === 'string' && value.startsWith('0001-') ? null : value ?? null;
      const candidate = { schemaVersion: 1, containerId: inspection.Id, imageId: inspection.Image,
        startedAt: time(inspection.State.StartedAt), finishedAt: time(inspection.State.FinishedAt),
        resources: { cpus: this.options.cpus, memoryBytes: this.options.memoryBytes, pids: this.options.pids, tmpBytes: this.options.tmpBytes } };
      const complete = containerEvidenceSchema.safeParse(candidate);
      // Daemon wall times can be malformed or go backwards. Unknown times preserve valid custody evidence;
      // invalid identity/profile omits optional evidence, never invalidates an independently observed exit.
      const bounded = complete.success ? complete : containerEvidenceSchema.safeParse({ ...candidate, startedAt: null, finishedAt: null });
      if (bounded.success) container = bounded.data;
    }
    const parsedWorker = workerIncarnationSchema.safeParse({ kind: 'container', id: inspection?.Id, startedAt: inspection?.State.StartedAt });
    const worker = parsedWorker.success ? parsedWorker.data : undefined;
    return Object.freeze({ handle, ...(worker ? { worker } : {}), result: Object.freeze(result), ...(container ? { container } : {}), stdout, stderr, interrupted, ...(interrupted ? { interruptCause: cause ?? 'deadline' } : {}), outputCompleteness: captured ? (interrupted ? 'partial' : 'complete') : 'unavailable' });
  }
  async cancel(input: SandboxRequest): Promise<Pick<SandboxResult, 'handle' | 'result' | 'container' | 'worker'>> {
    const { digest, handle } = this.identity(input); const existing = await this.inspect(handle, digest);
    if (existing && ['running', 'paused'].includes(existing.State.Status)) {
      try { await this.command(['kill', handle], this.options.controlTimeoutMs); } catch { /* Only subsequent observation proves termination. */ }
    }
    // Created/missing is unresolved: do not launch or delete evidence to manufacture a terminal state.
    const observed = this.result(handle, await this.inspect(handle, digest));
    return Object.freeze({ handle: observed.handle, result: observed.result, ...(observed.worker ? { worker: observed.worker } : {}), ...(observed.container ? { container: observed.container } : {}) });
  }
  async collectOutputFiles(input: SandboxRequest) {
    if (!this.options.outputFiles) return [];
    const { request, digest, handle } = this.identity(input);
    const existing = await this.inspect(handle, digest);
    if (!existing || existing.State.Status !== 'exited') throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
    const root = resolve(this.options.workspaceRoot); const workspace = resolve(request.workspace); const path = relative(root, workspace);
    if (!isAbsolute(request.workspace) || !path || path === '..' || path.startsWith('..' + sep)
      || await realpath(root) !== root) throw new SupervisorError('SUPERVISOR_WORKSPACE_INVALID');
    return collectDockerOutputFiles(workspace, this.options.outputFiles);
  }
  async recoverOutput(input: SandboxRequest): Promise<Readonly<{ stdout: string; stderr: string; completeness: 'partial' }>> {
    const { digest, handle } = this.identity(input); const existing = await this.inspect(handle, digest);
    if (!existing || existing.State.Status !== 'exited') throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
    try {
      const output = await this.command(['logs', handle], this.options.controlTimeoutMs);
      // Bounded daemon log rotation can remove earlier output. Never infer completeness from a successful read.
      return Object.freeze({ stdout: output.stdout, stderr: output.stderr, completeness: 'partial' });
    } catch { throw new SupervisorError('SUPERVISOR_CONTROL_FAILED'); }
  }
  async inspectActivity(input: SandboxRequest) {
    const { digest, handle } = this.identity(input); const existing = await this.inspect(handle, digest);
    const status = existing?.State.Status;
    const state = !existing ? 'missing' as const : status === 'running' || status === 'paused' || status === 'created' || status === 'exited' ? status : 'unknown' as const;
    return Object.freeze({ handle, state });
  }
  async observe(input: SandboxRequest): Promise<Pick<SandboxResult, 'handle' | 'result' | 'container' | 'worker'>> {
    const { digest, handle } = this.identity(input);
    const observed = this.result(handle, await this.inspect(handle, digest));
    return Object.freeze({ handle: observed.handle, result: observed.result, ...(observed.worker ? { worker: observed.worker } : {}), ...(observed.container ? { container: observed.container } : {}) });
  }
  async observeTermination(input: SandboxRequest, worker: import('#domain/index.js').WorkerIncarnation) {
    const expected = workerIncarnationSchema.parse(worker), { digest } = this.identity(input);
    const inspection = await this.inspect(expected.id, digest);
    if (!inspection) return { kind: 'worker-absent' as const, worker: expected };
    const observed = this.result(expected.id, inspection);
    if (!observed.worker || observed.worker.id !== expected.id || observed.worker.startedAt !== expected.startedAt) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
    return observed.result.kind === 'exited' ? { kind: 'supervisor-exit' as const, worker: observed.worker, result: observed.result } : null;
  }
  async execute(input: SandboxRequest, signal?: AbortSignal, hooks?: SupervisorLaunchHooks): Promise<SandboxResult> {
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
    const inputMounts: string[] = []; const expected: DockerExpectedMount[] = [{ source: workspace, target: '/workspace', writable: true }];
    const names = new Set<string>();
    for (const input of o.inputs ?? []) {
      const local = relative(root, input.path);
      if (input.receipt.scopeId !== request.identity.scopeId || names.has(input.name) || !isAbsolute(input.path)
        || input.path.includes(',') || input.path.includes(String.fromCharCode(0))
        || (local !== '..' && !local.startsWith('..' + sep)) || await realpath(input.path) !== input.path
        || !(await lstat(input.path)).isFile()) throw new SupervisorError('SUPERVISOR_REQUEST_INVALID');
      names.add(input.name);
      inputMounts.push('--mount', `type=bind,src=${input.path},dst=/deckent/inputs/${input.name},readonly`);
      expected.push({ source: input.path, target: `/deckent/inputs/${input.name}`, writable: false });
    }
    for (const input of o.handoffInputs ?? []) {
      const local = relative(root, input.path);
      if (input.receipt.scopeId !== request.identity.scopeId || names.has(input.target) || !isAbsolute(input.path)
        || input.path.includes(',') || input.path.includes(String.fromCharCode(0))
        || (local !== '..' && !local.startsWith('..' + sep)) || await realpath(input.path) !== input.path
        || !(await lstat(input.path)).isFile()) throw new SupervisorError('SUPERVISOR_REQUEST_INVALID');
      names.add(input.target);
      inputMounts.push('--mount', `type=bind,src=${input.path},dst=${input.target},readonly`);
      expected.push({ source: input.path, target: input.target, writable: false });
    }
    // Dependency binds (B06-2c) are re-checked at launch (real directory, outside the workspaces) and always read-only.
    const readOnlyMounts: string[] = [];
    for (const mount of o.readOnlyMounts ?? []) {
      await assertReadOnlyMountSource(mount.source, [root]);
      readOnlyMounts.push('--mount', `type=bind,src=${mount.source},dst=${mount.target},readonly`);
      expected.push({ source: mount.source, target: mount.target, writable: false });
    }
    const connectionMounts = o.connection ? await dockerConnectionMounts(o.connection, o.uid) : [];
    if (o.connection) expected.push({ source: o.connection.socketPath, target: '/run/deckent-connection.sock', writable: false },
      { source: o.connection.bootstrapPath, target: '/run/deckent-bootstrap.mjs', writable: false });
    const argv = o.connection ? ['node', '/run/deckent-bootstrap.mjs', ...request.argv] : request.argv;
    try {
      await this.command(['create', '--name', handle, '--label', 'deckent.request=' + digest,
        '--network', 'none', '--log-driver', 'local', '--log-opt', `max-size=${o.logMaxSizeKiB}k`,
        '--log-opt', `max-file=${o.logMaxFiles}`, '--log-opt', 'mode=blocking', ...this.floor(),
        '--mount', `type=bind,src=${workspace},dst=/workspace`, '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${o.tmpBytes}`,
        ...inputMounts, ...readOnlyMounts, ...connectionMounts, ...dockerNodeHeapEnvironment(o.memoryBytes), '--workdir', '/workspace', '--entrypoint', argv[0]!, o.imageId, ...argv.slice(1)], o.controlTimeoutMs);
    } catch {
      const existing = await this.inspect(handle, digest);
      if (existing) return this.result(handle, existing);
      throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    }
    // Created, not started: the realised mount set must be exactly the requested one before any task code can run.
    const created = await this.inspect(handle, digest);
    if (!created) throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    assertDockerMountsMatch(created.Mounts, expected);
    // S6R-1: the immutable id is durable before start, so a launcher that dies during `start --attach` still leaves the container named.
    if (hooks) {
      if (!/^[a-f0-9]{64}$/.test(created.Id)) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
      await hooks.created(created.Id);
    }
    let stdout: string; let stderr: string; let interrupted = false, cause: SandboxResult['interruptCause'];
    try {
      const output = await this.command(['start', '--attach', handle], o.deadlineMs, signal);
      stdout = output.stdout; stderr = output.stderr;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; killed?: boolean; code?: unknown; stop?: 'deadline' | 'signal' | null; stopReason?: unknown };
      stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
      stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
      interrupted = !!signal?.aborted || !!failure.killed || typeof failure.code !== 'number';
      // R3 (Astra 2642 F1): the first stop is fixed here, before inspect/kill; a watchdog abort during cleanup cannot relabel a deadline.
      cause = failure.stop ? sandboxInterruptCause(failure.stop, failure.stopReason) : !(error instanceof DockerCommandFailure) && signal?.aborted ? sandboxInterruptCause('signal', signal.reason) : undefined;
      const observed = await this.inspect(handle, digest);
      if (observed?.State.Status === 'exited') return this.result(handle, observed, stdout, stderr, interrupted, true, cause);
      interrupted = true;
      // An interrupted CLI is not proof the container stopped. Kill, then inspect authoritative daemon state.
      try { await this.command(['kill', handle], o.controlTimeoutMs); } catch { /* Inspect determines terminal truth. */ }
    }
    return this.result(handle, await this.inspect(handle, digest), stdout, stderr, interrupted, true, cause);
  }
  /** The one sandbox floor of every container this supervisor starts (read-only root, no capabilities or new privileges, bounded resources). */
  private floor() {
    const o = this.options;
    return ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', String(o.pids), '--memory', String(o.memoryBytes),
      '--memory-swap', String(o.memoryBytes), '--cpus', String(o.cpus), '--ipc', 'private', '--cgroupns', 'private', '--user', `${o.uid}:${o.gid}`];
  }
  /** PRE-7 / REVISE 2691: a probe's identity is deterministic per installation (workspace root), Run, task and probe argv — not per attempt —
   * so a re-entry or a resumed generation meets the same container instead of starting a second one. Labels carry the installation. */
  probeIdentity(input: SandboxRequest, argv: readonly string[]) {
    const { request } = this.identity(input), root = this.probeRoot(), { scopeId, runId, taskId } = request.identity;
    return Object.freeze({ name: 'deckent-env-' + createHash('sha256').update(JSON.stringify({ root, scopeId, runId, taskId, argv })).digest('hex'), root });
  }
  private probeRoot() { return createHash('sha256').update(JSON.stringify(resolve(this.options.workspaceRoot))).digest('hex'); }
  /** Removed and observed absent; `false` when that cannot be proven (rm failed, still present, or the daemon gave no answer). */
  private async gone(ref: string): Promise<boolean> {
    await this.command(['rm', '--force', ref], this.options.controlTimeoutMs).catch(() => undefined);
    try { await this.command(['inspect', '--format', '{{.Id}}', ref], this.options.controlTimeoutMs); return false; }
    catch (error) { return error instanceof DockerCommandFailure && error.stderr.toLowerCase().includes('no such object: ' + ref.toLowerCase()); }
  }
  /** PRE-7: one environment probe on the worker's floor (same image, user, `--network none`, sandbox flags, tmpfs, Node heap environment and
   * re-checked read-only dependency binds), without the workspace and never the connection: no credential, no model. `argv` comes only from
   * an adapter's probe-kind registry. Exit 0 = met, any other exit = unmet, stopped by its own `timeoutMs` = `timed-out` (no answer: E1,
   * never unmet) — each only once the container is removed and observed absent (a deadline stops the CLI, not the container). REVISE 2691: a leftover of the same identity (crashed controller) is
   * removed first; whenever removal cannot be proven the answer is `uncertain` with the container name and no new container is started.
   * A daemon refusal (exit 125) or an unclassified failure with the container proven gone stays a control failure (transient). */
  async probe(input: SandboxRequest, argv: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<'met' | 'unmet' | 'timed-out' | Readonly<{ uncertain: string }>> {
    const { digest } = this.identity(input), o = this.options, { name, root } = this.probeIdentity(input, argv), mounts: string[] = [];
    for (const mount of o.readOnlyMounts ?? []) { await assertReadOnlyMountSource(mount.source, [resolve(o.workspaceRoot)]); mounts.push('--mount', `type=bind,src=${mount.source},dst=${mount.target},readonly`); }
    const leftover = await this.command(['inspect', '--format', '{{.Id}}', name], o.controlTimeoutMs).then(() => true, (error: unknown) => !(error instanceof DockerCommandFailure && error.stderr.toLowerCase().includes('no such object: ' + name)));
    if (leftover && !await this.gone(name)) return Object.freeze({ uncertain: name });
    let answer: 'met' | 'unmet' | 'timed-out' | null = null;
    try {
      await this.command(['run', '--name', name, '--label', 'deckent.preflight=' + digest, '--label', 'deckent.preflight.root=' + root, '--network', 'none', ...this.floor(), '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${o.tmpBytes}`,
        ...mounts, ...dockerNodeHeapEnvironment(o.memoryBytes), '--workdir', '/tmp', '--entrypoint', argv[0]!, o.imageId, ...argv.slice(1)], timeoutMs, signal);
      answer = 'met';
    } catch (error) {
      if (error instanceof DockerCommandFailure) answer = error.stop === 'deadline' ? 'timed-out' : typeof error.code === 'number' && error.code !== DOCKER_RUN_DAEMON_FAILURE ? 'unmet' : null;
    }
    if (!await this.gone(name)) return Object.freeze({ uncertain: name });
    if (answer === null) throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    return answer;
  }
  /** REVISE 2691: the service-start sweep entry. Removal only: its caller never holds a launch-capable supervisor (S6 launch-site test). */
  static sweepPreflightProbes(input: DockerSupervisorOptions, runner?: DockerCommandRunner) { return new DockerSupervisor(input, runner).releasePreflightProbes(); }
  /** REVISE 2693, removal-only: proves one recorded probe container (by its deterministic `deckent-env-` name) removed; false when not provable. */
  static removePreflightProbe(input: DockerSupervisorOptions, name: string, runner?: DockerCommandRunner): Promise<boolean> {
    return PREFLIGHT_PROBE_NAME.test(name) ? new DockerSupervisor(input, runner).gone(name) : Promise.resolve(false);
  }
  /** REVISE 2691, startup recovery: this installation's labelled probe containers (none is live at service start) are removed and observed
   * absent; another installation's or any unlabelled container is never listed. Unproven removals are reported, never assumed. */
  async releasePreflightProbes(): Promise<Readonly<{ removed: number; unsettled: readonly string[] }>> {
    const listed = (await this.command(['ps', '-aq', '--no-trunc', '--filter', 'label=deckent.preflight.root=' + this.probeRoot()], this.options.controlTimeoutMs)).stdout.split('\n').map(line => line.trim()).filter(Boolean);
    const unsettled: string[] = []; let removed = 0;
    for (const id of listed) { if (/^[a-f0-9]{64}$/.test(id) && await this.gone(id)) removed++; else unsettled.push(id); }
    return Object.freeze({ removed, unsettled: Object.freeze(unsettled) });
  }
  /** EXEC-RELEASE: only the labelled, exited container of this exact request, removed by its immutable id (no name reuse between
   * inspect and rm), never forced; success requires Docker to echo that id and a later inspect to report it absent. */
  async release(input: SandboxRequest): Promise<'removed' | 'absent'> {
    const { digest, handle } = this.identity(input); const existing = await this.inspect(handle, digest);
    if (!existing) return 'absent';
    if (existing.State.Status !== 'exited') throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
    if (!/^[a-f0-9]{64}$/.test(existing.Id)) throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    let removed = '';
    try { removed = (await this.command(['rm', '--volumes', existing.Id], this.options.controlTimeoutMs)).stdout.trim(); } catch { /* absence decides */ }
    if (removed !== existing.Id || await this.inspect(existing.Id, digest) !== null) throw new SupervisorError('SUPERVISOR_RELEASE_UNCONFIRMED');
    return 'removed';
  }
}
