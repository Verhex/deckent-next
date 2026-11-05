import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { redactForRecord, snapshotKnownSecrets, type KnownSecretSnapshot, type JsonRecordFile } from '#platform/index.js';
import { nativeWorkerGuardRefusal, toolSessionSchema, type ToolSessionPort } from '#capabilities/index.js';
import { executionProfileDefinitionSchema, type ExecutionProfileDefinition, type WorkerEvent } from '#domain/index.js';
import { sameSandboxRequest, sandboxRequestSchema, sandboxResultSchema, supervisorProfileSchema, sandboxInterruptCause, SupervisorError,
  type ExecutionSupervisor, type SandboxRequest, type SandboxResult, type SupervisorProfileSource } from '#engine/index.js';
import { createNativeToolBridge } from '#adapters/core/native-tool-bridge/index.js';
import { readFinalReportText } from '#adapters/core/native-connection/index.js';
import { collectDockerOutputFiles } from '#adapters/core/docker-supervisor/index.js';
import { resolveNativeCliWorkerProfile } from './profile.js';
import { inspectNativeCliWorker } from './readiness.js';
import type { NativeCliWorkerPorts, NativeCliWorkerDriver, NativeCliWorkerToolContext } from './ports.js';
import { retainActiveNativeWorker, retainNativeWorkerResult } from './recorded.js';

export function validateNativeCliWorkerSupervisorProfile(input: unknown): undefined {
  const profile = supervisorProfileSchema.parse(input);
  if (profile.adapterId !== 'native-cli-worker' || profile.adapterVersion !== 1) throw new SupervisorError('SUPERVISOR_PROFILE_INVALID');
  resolveNativeCliWorkerProfile(profile.parameters['task'] as ExecutionProfileDefinition);
  return undefined;
}
export async function prepareNativeCliWorker(input: Readonly<{ profile: ExecutionProfileDefinition; request: SandboxRequest; ports: NativeCliWorkerPorts;
  fence(): Promise<boolean>; dependencyContext?: string; knownSecrets?: KnownSecretSnapshot; toolContext?: NativeCliWorkerToolContext;
  custody?: JsonRecordFile; onEvents?: (events: readonly WorkerEvent[]) => void }>, signal: AbortSignal = new AbortController().signal) {
  const frozen = Object.freeze({ ...input, request: sandboxRequestSchema.parse(input.request), profile: executionProfileDefinitionSchema.parse(input.profile) });
  const resolved = resolveNativeCliWorkerProfile(frozen.profile), ready = await inspectNativeCliWorker(resolved.binding, frozen.ports);
  if (frozen.request.argv.length !== resolved.argv.length || frozen.request.argv.some((arg, index) => arg !== resolved.argv[index])) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
  if (ready.state !== 'ready') return ready;
  // Owner 2026-11-05: the worker follows the connection's current sealed CLI version (recorded with the Attempt's execution), not the template's.
  if ((resolved.readOnlyMounts?.length ?? 0) !== (input.toolContext?.readOnlyMounts?.length ?? 0)) return { state: 'waiting' as const, reason: 'NATIVE_AGENT_ENVIRONMENT_REFUSED' as const };
  if (signal.aborted) throw new SupervisorError('SUPERVISOR_CANCELLED');
  await frozen.ports.recheck(frozen.request, resolved.binding, signal);
  if (!await frozen.fence()) return { state: 'waiting' as const, reason: 'NATIVE_AGENT_ENVIRONMENT_REFUSED' as const };
  const slot = await frozen.ports.capacity.acquire(frozen.request, resolved.binding, signal);
  if (slot.state !== 'acquired') return { state: 'waiting' as const, reason: 'NATIVE_WORKER_CAPACITY_WAIT' as const };
  if (signal.aborted) { await slot.release(); throw new SupervisorError('SUPERVISOR_CANCELLED'); }
  if (frozen.ports.verification && !input.custody) { await slot.release(); return { state: 'waiting' as const, reason: 'NATIVE_WORKER_F08_REQUIRED' as const }; }
  const verification = frozen.ports.verification ? await frozen.ports.verification!.acquire(frozen.request, resolved.binding, ready.execution).catch(async (error: unknown) => { await slot.release(); throw error; }) : undefined;
  if (verification === null) { await slot.release(); return { state: 'waiting' as const, reason: 'NATIVE_WORKER_VERIFICATION_WAIT' as const }; }
  const supervisor = new NativeCliWorkerSupervisor(frozen, slot.release.bind(slot), verification);
  return Object.freeze({ state: 'ready' as const, supervisor });
}

class NativeCliWorkerSupervisor implements ExecutionSupervisor, SupervisorProfileSource {
  private readonly lifetime = new AbortController();
  private readonly resolved;
  private readonly handle;
  private started = false;
  private released = false;
  private result: SandboxResult | undefined;
  private running: Promise<SandboxResult> | undefined;
  private driver: NativeCliWorkerDriver | undefined;
  private bridge: Awaited<ReturnType<typeof createNativeToolBridge>> | undefined;
  private verdict: import('#capabilities/index.js').NativeWorkerEvidenceVerdict | undefined;
  private forget: (() => void) | undefined;
  constructor(private readonly input: Parameters<typeof prepareNativeCliWorker>[0], private readonly releaseCapacity: () => Promise<void>,
    private readonly verification?: Awaited<ReturnType<NonNullable<NativeCliWorkerPorts['verification']>['acquire']>>) {
    this.resolved = resolveNativeCliWorkerProfile(input.profile);
    this.handle = `native-cli-worker-${createHash('sha256').update(JSON.stringify(input.request.identity)).digest('hex')}`;
  }
  async captureProfile() { return supervisorProfileSchema.parse({ schemaVersion: 1, adapterId: 'native-cli-worker', adapterVersion: 1, parameters: { task: this.input.profile } }); }
  private check(request: SandboxRequest) { if (!sameSandboxRequest(request, this.input.request)) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT'); }
  private unknown(reasonCode: string): SandboxResult { return { handle: this.handle, result: { kind: 'unknown', reasonCode }, stdout: '', stderr: '', outputCompleteness: 'unavailable', interrupted: this.lifetime.signal.aborted }; }
  async execute(request: SandboxRequest, signal?: AbortSignal): Promise<SandboxResult> {
    this.check(request);
    if (this.released) throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
    if (!this.running) {
      if (this.input.custody) this.forget = retainActiveNativeWorker(request, this);
      this.running = this.run(signal).then(async result => {
        const parsed = sandboxResultSchema.parse(result);
        if (this.input.custody) {
          try { await retainNativeWorkerResult(this.input.custody, request, await this.captureProfile(), parsed); }
          catch { return this.result = this.unknown('NATIVE_WORKER_CUSTODY_UNKNOWN'); }
        }
        return this.result = parsed;
      });
    }
    return this.running;
  }
  private async run(signal?: AbortSignal): Promise<SandboxResult> {
    const deadline = AbortSignal.timeout(this.resolved.options.deadlineMs), combined = AbortSignal.any([this.lifetime.signal, deadline, ...(signal ? [signal] : [])]);
    let interruptCause: SandboxResult['interruptCause'];
    const stop = () => { interruptCause ??= sandboxInterruptCause(deadline.aborted ? 'deadline' : 'signal', signal?.reason); };
    combined.addEventListener('abort', stop, { once: true }); if (combined.aborted) stop();
    let tools: ToolSessionPort | undefined, outcome: SandboxResult;
    try { work: {
      const ready = await inspectNativeCliWorker(this.resolved.binding, this.input.ports);
      if (ready.state !== 'ready') { outcome = this.unknown(ready.reason); break work; }
      const guard = async () => {
        if (combined.aborted || !await this.input.fence()) throw new SupervisorError('SUPERVISOR_CANCELLED');
        await this.input.ports.recheck(this.input.request, this.resolved.binding, combined);
      };
      await guard();
      tools = await this.input.ports.openTools(this.input.request, this.resolved.binding, combined, this.input.toolContext ?? {});
      const session = toolSessionSchema.parse(tools.session), delegate = tools;
      const guarded: ToolSessionPort = { session, terminalFailure: () => delegate.terminalFailure?.() ?? null, async propose(call, correlation, signal) {
        await guard(); if (signal.aborted) throw new SupervisorError('SUPERVISOR_CANCELLED');
        return delegate.propose(call, correlation, AbortSignal.any([combined, signal]));
      }, cancel: () => delegate.cancel(), revoke: () => delegate.revoke() };
      const binding = this.resolved.nativeSubscription!, delivery = binding.promptDelivery!;
      this.driver = await this.input.ports.driver({ binding: this.resolved.binding, tools: guarded, model: binding.model!.modelId,
        system: delivery.core, user: delivery.task + (this.input.dependencyContext ? `\n\n${this.input.dependencyContext}` : ''),
        deadlineMs: this.resolved.options.deadlineMs, outputBytes: this.resolved.options.outputBytes, execution: ready.execution,
        ...(binding.reasoningEffort ? { effort: binding.reasoningEffort } : {}),
        ...(this.input.onEvents ? { onEvents: batch => {
          if (!this.bridge) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
          const known = snapshotKnownSecrets([{ name: this.bridge.tokenEnvName, value: this.bridge.turnToken }]);
          const redact = (value: unknown): unknown => typeof value === 'string' ? redactForRecord(this.input.knownSecrets ? redactForRecord(value, this.input.knownSecrets) : value, known)
            : Array.isArray(value) ? value.map(redact) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)])) : value;
          this.input.onEvents!(redact(batch) as readonly WorkerEvent[]);
        } } : {}),
        ...(this.resolved.entry.command.capabilities.maxTurns && this.resolved.argv.includes(this.resolved.entry.command.capabilities.maxTurns.flag)
          ? { maxTurns: Number(this.resolved.argv[this.resolved.argv.indexOf(this.resolved.entry.command.capabilities.maxTurns.flag) + 1]) } : {}) }, combined);
      if (!isDeepStrictEqual(this.driver.tools.session, session)) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
      this.bridge = await createNativeToolBridge({ port: this.driver.tools, bridge: this.resolved.entry.bridge, limits: this.input.ports.bridgeLimits,
        correlationKind: this.resolved.entry.agent.transport.kind === 'claude-mcp' ? 'claude-tool-use' : 'codex-mcp', signal: combined,
        ...(this.input.knownSecrets ? { knownSecrets: this.input.knownSecrets } : {}) });
      // The last fence and lease check is immediately before the sole CLI spawn; the runtime receives no workspace path.
      await guard(); this.started = true;
      const result = await this.driver.run(this.bridge, combined);
      if (result.termination !== 'confirmed') { outcome = this.unknown('NATIVE_WORKER_TERMINATION_UNKNOWN'); break work; }
      if (result.refusal) {
        if (!this.verification) { outcome = this.unknown(result.refusal); break work; }
        const reason = nativeWorkerGuardRefusal(result.refusal); this.verdict = { state: 'refused', reason };
        outcome = { handle: this.handle, result: { kind: 'exited', exitCode: 1 }, stdout: '', stderr: reason, outputCompleteness: 'complete', interrupted: false }; break work;
      }
      if (result.status === 'completed' && !combined.aborted) this.verdict = { state: 'verified' };
      const known = snapshotKnownSecrets([{ name: this.bridge.tokenEnvName, value: this.bridge.turnToken }]);
      const text = redactForRecord(this.input.knownSecrets ? redactForRecord(result.text, this.input.knownSecrets) : result.text, known);
      if (Buffer.byteLength(text) > this.resolved.options.outputBytes) { outcome = this.unknown('NATIVE_WORKER_OUTPUT_LIMIT'); break work; }
      const report = binding.finalReport ? readFinalReportText(text, []) : null;
      const stdout = report ? `${JSON.stringify({ schemaVersion: 1, kind: 'native-worker-report', ...report })}\n` : text;
      if (Buffer.byteLength(stdout) > this.resolved.options.outputBytes) { outcome = this.unknown('NATIVE_WORKER_OUTPUT_LIMIT'); break work; }
      outcome = { handle: this.handle, result: { kind: 'exited', exitCode: result.status === 'completed' && !combined.aborted ? 0 : 1 },
        stdout, stderr: '', outputCompleteness: 'complete', interrupted: combined.aborted, ...(interruptCause ? { interruptCause } : {}) };
    } } catch { outcome = this.unknown(combined.aborted ? 'NATIVE_WORKER_STOP_UNCONFIRMED' : 'NATIVE_CLI_WORKER_UNAVAILABLE'); }
    finally {
      combined.removeEventListener('abort', stop);
      // Close the facade first. Cleanup is evidence: failed/unverified tool settlement cannot become a successful process result.
      const [closed, cancelled, disposed] = await Promise.allSettled([this.bridge?.close(), tools?.cancel(), this.driver?.close()]);
      if ([closed, cancelled, disposed].some(result => result.status === 'rejected')) outcome = this.unknown('NATIVE_WORKER_STOP_UNCONFIRMED');
      else if (cancelled.status === 'fulfilled') {
        const closure = cancelled.value;
        if (tools && (!closure || closure.turnId !== tools.session.turnId || closure.generation !== tools.session.generation
          || closure.effects !== 'settled' || closure.pendingCallIds.length)) outcome = this.unknown('NATIVE_WORKER_EFFECTS_UNKNOWN');
      }
    }
    return outcome;
  }
  async cancel(request: SandboxRequest) {
    this.check(request); this.lifetime.abort();
    const result = this.running ? await this.running : this.unknown('NATIVE_WORKER_NOT_STARTED');
    return { handle: result.handle, result: result.result };
  }
  async observe(request: SandboxRequest) {
    this.check(request); const result = this.result ?? this.unknown('NATIVE_WORKER_CUSTODY_UNKNOWN');
    return { handle: result.handle, result: result.result };
  }
  async recoverOutput(request: SandboxRequest) { this.check(request); return { stdout: this.result?.stdout ?? '', stderr: '', completeness: 'partial' as const }; }
  async collectOutputFiles(request: SandboxRequest) {
    this.check(request); if (this.result?.result.kind !== 'exited') throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
    return this.resolved.options.outputFiles ? collectDockerOutputFiles(request.workspace, this.resolved.options.outputFiles) : [];
  }
  async inspectActivity(request: SandboxRequest) {
    this.check(request);
    if (this.result?.result.kind === 'exited') return { handle: this.handle, state: 'exited' as const };
    return this.driver?.inspectActivity ? this.driver.inspectActivity() : { handle: null, state: 'unknown' as const };
  }
  /** Called only after DispatchApplication has retained output and terminal evidence. Unknown CLI/effects keep capacity for reconciliation. */
  async release(request: SandboxRequest): Promise<'absent'> {
    this.check(request); if (this.released) return 'absent';
    if (this.started && this.result?.result.kind !== 'exited') throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
    if (this.verification) {
      if (this.result?.result.kind === 'exited' && this.verdict) await this.verification.finish(this.verdict);
      else if (!this.started || this.result?.result.kind === 'exited') await this.verification.abandon();
    }
    await this.releaseCapacity(); this.released = true; this.forget?.(); return 'absent';
  }
  async close(): Promise<void> { if (!this.started) await this.release(this.input.request); }
}
