import { isDeepStrictEqual } from 'node:util';
import { DeckentError, headlessDiagnosticIdentifier, type KnownSecretSnapshot, type JsonRecordFile } from '#platform/index.js';
import { CODEX_TOOL_ITEM_RESERVATION, nativeWorkerGuardRefusal, toolSessionSchema, type ToolSessionPort } from '#capabilities/index.js';
import { executionProfileDefinitionSchema, type ExecutionProfileDefinition, type WorkerEvent } from '#domain/index.js';
import { sameSandboxRequest, sandboxRequestSchema, sandboxResultSchema, supervisorProfileSchema, sandboxInterruptCause, SupervisorError, protectedWorkerObservation,
  type ExecutionSupervisor, type SandboxRequest, type SandboxResult, type SupervisorProfile, type SupervisorProfileSource } from '#engine/index.js';
import { createNativeToolBridge } from '#adapters/core/native-tool-bridge/index.js';
import { nativeAgentCorrelationKind } from '#adapters/core/native-cli-headless/index.js';
import { finalReportTextInstruction, readFinalReportText } from '#adapters/core/native-connection/index.js';
import { collectDockerOutputFiles } from '#adapters/core/docker-supervisor/index.js';
import { NATIVE_CLI_WORKER_ADAPTER, resolveNativeCliWorkerProfile } from './profile.js';
import { inspectNativeCliWorker } from './readiness.js';
import type { NativeCliWorkerPorts, NativeCliWorkerDriver, NativeCliWorkerToolContext } from './ports.js';
import { nativeCliWorkerHandle, retainActiveNativeWorker, retainNativeWorkerResult } from './recorded.js';

export function isNativeCliWorkerSupervisorProfile(input: SupervisorProfile): boolean {
  try { validateNativeCliWorkerSupervisorProfile(input); return true; }
  catch { return false; }
}
export function validateNativeCliWorkerSupervisorProfile(input: unknown): undefined {
  const profile = supervisorProfileSchema.parse(input);
  const task = executionProfileDefinitionSchema.parse(profile.parameters['task']);
  if (profile.adapterId !== NATIVE_CLI_WORKER_ADAPTER.id || profile.adapterVersion !== task.adapter.version) throw new SupervisorError('SUPERVISOR_PROFILE_INVALID');
  resolveNativeCliWorkerProfile(task);
  return undefined;
}
export async function prepareNativeCliWorker(input: Readonly<{ profile: ExecutionProfileDefinition; request: SandboxRequest; ports: NativeCliWorkerPorts;
  fence(): Promise<boolean>; dependencyContext?: string; /** D4: the person's report language (ISO 639-1). */ language?: string; knownSecrets?: KnownSecretSnapshot; toolContext?: NativeCliWorkerToolContext;
  custody?: JsonRecordFile; onEvents?: (events: readonly WorkerEvent[]) => void }>, signal: AbortSignal = new AbortController().signal) {
  const frozen = Object.freeze({ ...input, request: sandboxRequestSchema.parse(input.request), profile: executionProfileDefinitionSchema.parse(input.profile) });
  const resolved = resolveNativeCliWorkerProfile(frozen.profile), ready = await inspectNativeCliWorker(resolved.binding, frozen.ports);
  if (frozen.request.argv.length !== resolved.argv.length || frozen.request.argv.some((arg, index) => arg !== resolved.argv[index])) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
  if (ready.state !== 'ready') return ready;
  // Owner 2026-11-05: the worker follows the connection's current sealed CLI version (recorded with the Attempt's execution), not the template's.
  if ((resolved.readOnlyMounts?.length ?? 0) !== (input.toolContext?.readOnlyMounts?.length ?? 0)) return { state: 'waiting' as const, reason: 'NATIVE_AGENT_ENVIRONMENT_REFUSED' as const };
  if (resolved.dependencies?.state === 'declared' || resolved.dependencies?.listDigest !== input.toolContext?.sealedNodeModules?.digest) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
  if (signal.aborted) throw new SupervisorError('SUPERVISOR_CANCELLED');
  await frozen.ports.recheck(frozen.request, resolved.binding, signal);
  if (!await frozen.fence()) return { state: 'waiting' as const, reason: 'NATIVE_AGENT_ENVIRONMENT_REFUSED' as const };
  const slot = await frozen.ports.capacity.acquire(frozen.request, resolved.binding, signal);
  if (slot.state !== 'acquired') return { state: 'waiting' as const, reason: 'NATIVE_WORKER_CAPACITY_WAIT' as const };
  if (signal.aborted) { await slot.release(); throw new SupervisorError('SUPERVISOR_CANCELLED'); }
  if (frozen.ports.verification && !input.custody) { await slot.release(); return { state: 'waiting' as const, reason: 'NATIVE_WORKER_F08_REQUIRED' as const }; }
  const verification = frozen.ports.verification ? await frozen.ports.verification!.acquire(frozen.request, resolved.binding, ready.execution).catch(async (error: unknown) => { await slot.release(); throw error; }) : undefined;
  if (verification === null) { await slot.release(); return { state: 'waiting' as const, reason: 'NATIVE_WORKER_VERIFICATION_WAIT' as const }; }
  const supervisor = new NativeCliWorkerSupervisor(frozen, resolved, slot.release.bind(slot), verification);
  return Object.freeze({ state: 'ready' as const, supervisor });
}

class NativeCliWorkerSupervisor implements ExecutionSupervisor, SupervisorProfileSource {
  private readonly lifetime = new AbortController();
  private readonly handle;
  private started = false;
  private released = false;
  /** N0: events are taken only while the CLI runs (spawn to the top of `finally`); `offered` once the driver produced its one observation. */
  private acceptingEvents = false; private offered = false;
  /** N0 R2: one in-flight release; a concurrent custody sweep or patch preparation joins it, a rejection lets the next call retry as before. */
  private releasing: Promise<'absent'> | undefined;
  offeredObservation(): boolean { return this.offered; }
  private result: SandboxResult | undefined;
  private running: Promise<SandboxResult> | undefined;
  private driver: NativeCliWorkerDriver | undefined;
  private bridge: Awaited<ReturnType<typeof createNativeToolBridge>> | undefined;
  private verdict: import('#capabilities/index.js').NativeWorkerEvidenceVerdict | undefined;
  private forget: (() => void) | undefined;
  constructor(private readonly input: Parameters<typeof prepareNativeCliWorker>[0], private readonly resolved: ReturnType<typeof resolveNativeCliWorkerProfile>,
    private readonly releaseCapacity: () => Promise<void>, private readonly verification?: Awaited<ReturnType<NonNullable<NativeCliWorkerPorts['verification']>['acquire']>>) {
    this.handle = nativeCliWorkerHandle(input.request.identity);
  }
  async captureProfile() { return supervisorProfileSchema.parse({ schemaVersion: 1, adapterId: NATIVE_CLI_WORKER_ADAPTER.id, adapterVersion: this.input.profile.adapter.version, parameters: { task: this.input.profile } }); }
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
    let tools: ToolSessionPort | undefined, outcome: SandboxResult, diagnostic: typeof CODEX_TOOL_ITEM_RESERVATION | undefined, settledFailure: string | undefined, primaryFailure: string | undefined;
    try { work: {
      const ready = await inspectNativeCliWorker(this.resolved.binding, this.input.ports);
      if (ready.state !== 'ready') { outcome = this.unknown(ready.reason); break work; }
      const guard = async () => {
        try {
          if (combined.aborted || !await this.input.fence()) throw new SupervisorError('SUPERVISOR_CANCELLED');
          await this.input.ports.recheck(this.input.request, this.resolved.binding, combined);
        } catch (error) { if (tools) { try { await tools.revoke(); } finally { this.lifetime.abort(); } } throw error; }
      };
      await guard();
      tools = await this.input.ports.openTools(this.input.request, this.resolved.binding, combined, this.input.toolContext ?? {});
      const session = toolSessionSchema.parse(tools.session), delegate = tools;
      const guarded: ToolSessionPort = { ...delegate, session, terminalFailure: () => delegate.terminalFailure?.() ?? null, async propose(call, correlation, signal) {
        await guard(); if (signal.aborted) throw new SupervisorError('SUPERVISOR_CANCELLED');
        return delegate.propose(call, correlation, AbortSignal.any([combined, signal]));
      }, cancel: () => delegate.cancel(), revoke: () => delegate.revoke() };
      const binding = this.resolved.nativeSubscription!, delivery = binding.promptDelivery!;
      this.driver = await this.input.ports.driver({ binding: this.resolved.binding, tools: guarded, model: binding.model!.modelId,
        system: delivery.core, user: delivery.task + (this.input.dependencyContext ? `\n\n${this.input.dependencyContext}` : '') + (binding.finalReport ? `\n\n${finalReportTextInstruction(this.input.language)}` : ''),
        deadlineMs: this.resolved.options.deadlineMs, outputBytes: this.resolved.options.outputBytes, execution: ready.execution,
        ...(binding.reasoningEffort ? { effort: binding.reasoningEffort } : {}),
        ...(this.input.onEvents ? { onEvents: batch => {
          if (!this.acceptingEvents) return;
          if (!this.bridge) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
          // KG8 P13: the bridge's one projection (configured secrets and the turn token), keys included.
          const project = this.bridge.project, redact = (value: unknown): unknown => typeof value === 'string' ? project(value) : Array.isArray(value) ? value.map(redact)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [project(key), redact(child)])) : value;
          const ordinary = batch.filter(event => event.kind !== 'cli.observation');
          if (ordinary.length === batch.length) { this.input.onEvents!(redact(batch) as readonly WorkerEvent[]); return; }
          if (ordinary.length) this.input.onEvents!(redact(ordinary) as readonly WorkerEvent[]);
          // N0: the first observation travels alone, projected by the host; a refused handover is reported by the close owner, never rethrown here.
          const row = protectedWorkerObservation(batch.find(event => event.kind === 'cli.observation'), project); this.offered = true;
          try { if (row) this.input.onEvents!([row]); } catch { /* unconfirmed handover: WORKER_EVENTS_SEAL_FAILED at close */ }
        } } : {}),
        ...(this.resolved.maxTurns === undefined ? {} : { maxTurns: this.resolved.maxTurns }) }, combined);
      if (!isDeepStrictEqual(this.driver.tools.session, session)) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
      this.bridge = await createNativeToolBridge({ port: this.driver.tools, bridge: this.resolved.entry.bridge, limits: this.input.ports.bridgeLimits,
        correlationKind: nativeAgentCorrelationKind(this.resolved.entry), signal: combined,
        ...(this.input.knownSecrets ? { knownSecrets: this.input.knownSecrets } : {}) });
      // The last fence and lease check is immediately before the sole CLI spawn; the runtime receives no workspace path.
      await guard(); this.started = true; this.acceptingEvents = true;
      const result = await this.driver.run(this.bridge, combined);
      primaryFailure = result.refusal ?? result.failureCode;
      if (result.cleanupError) {
        settledFailure = primaryFailure
          ?? headlessDiagnosticIdentifier(result.cleanupError.code, result.cleanupError.params ?? {}) ?? 'NATIVE_WORKER_STOP_UNCONFIRMED';
        outcome = this.unknown(settledFailure); break work;
      }
      if (result.termination !== 'confirmed') { outcome = this.unknown('NATIVE_WORKER_TERMINATION_UNKNOWN'); break work; }
      if (result.stopped && !this.verification) { outcome = this.unknown(primaryFailure ?? 'NATIVE_WORKER_TERMINATION_UNKNOWN'); break work; }
      if (result.refusal) {
        const turnOnly = result.refusal === 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED' && result.text === CODEX_TOOL_ITEM_RESERVATION;
        if (!this.verification && !turnOnly) { outcome = this.unknown(result.refusal); break work; }
        const reason = turnOnly ? CODEX_TOOL_ITEM_RESERVATION : nativeWorkerGuardRefusal(result.refusal);
        // A turn-only failure abandons the verification claim when the Attempt releases.
        if (reason === CODEX_TOOL_ITEM_RESERVATION) diagnostic = reason;
        else this.verdict = { state: 'refused', reason };
        outcome = { handle: this.handle, result: { kind: 'exited', exitCode: 1 }, stdout: '', stderr: reason, outputCompleteness: 'complete', interrupted: false }; break work;
      }
      if (result.status === 'completed' && !combined.aborted) this.verdict = { state: 'verified' };
      const text = this.bridge.project(result.text);
      if (Buffer.byteLength(text) > this.resolved.options.outputBytes) { outcome = this.unknown('NATIVE_WORKER_OUTPUT_LIMIT'); break work; }
      const report = binding.finalReport ? readFinalReportText(text, []) : null;
      const stdout = report ? `${JSON.stringify({ schemaVersion: 1, kind: 'native-worker-report', ...report })}\n` : text;
      if (Buffer.byteLength(stdout) > this.resolved.options.outputBytes) { outcome = this.unknown('NATIVE_WORKER_OUTPUT_LIMIT'); break work; }
      outcome = { handle: this.handle, result: { kind: 'exited', exitCode: result.status === 'completed' && !combined.aborted ? 0 : 1 },
        stdout, stderr: '', outputCompleteness: 'complete', interrupted: combined.aborted, ...(interruptCause ? { interruptCause } : {}) };
    } } catch (error) {
      settledFailure = error instanceof DeckentError ? headlessDiagnosticIdentifier(error.code, error.params ?? {}) : undefined;
      outcome = this.unknown(settledFailure ?? (combined.aborted ? 'NATIVE_WORKER_STOP_UNCONFIRMED' : 'NATIVE_CLI_WORKER_UNAVAILABLE'));
    }
    finally {
      this.acceptingEvents = false;
      combined.removeEventListener('abort', stop);
      // Failed/unverified tool settlement cannot become a successful process result.
      const [closed, cancelled, disposed] = await Promise.allSettled([this.bridge?.close(), tools?.cancel(), this.driver?.close()]);
      if (!settledFailure && [closed, cancelled, disposed].some(result => result.status === 'rejected'))
        outcome = this.unknown(primaryFailure ?? 'NATIVE_WORKER_STOP_UNCONFIRMED');
      else if (!settledFailure && cancelled.status === 'fulfilled') {
        const closure = cancelled.value;
        if (tools && (!closure || closure.turnId !== tools.session.turnId || closure.generation !== tools.session.generation
          || closure.effects !== 'settled' || closure.pendingCallIds.length)) outcome = this.unknown(primaryFailure ?? 'NATIVE_WORKER_EFFECTS_UNKNOWN');
      }
    }
    if (!diagnostic) return outcome;
    // The first call can settle its approval after the stream refuses the second request.
    return { ...outcome, stderr: diagnostic, stdout: tools?.terminalFailure?.() === 'approval-expired' ? 'APPROVAL_EXPIRED' : outcome.stdout };
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
  async recoverOutput(request: SandboxRequest) { this.check(request); return { stdout: this.result?.stdout ?? '', stderr: this.result?.stderr === CODEX_TOOL_ITEM_RESERVATION ? CODEX_TOOL_ITEM_RESERVATION : '', completeness: 'partial' as const }; }
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
    return this.releasing ??= this.settleRelease().finally(() => { this.releasing = undefined; });
  }
  private async settleRelease(): Promise<'absent'> {
    if (this.started && this.result?.result.kind !== 'exited') throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
    if (this.verification) {
      if (this.result?.result.kind === 'exited' && this.verdict) await this.verification.finish(this.verdict);
      else if (!this.started || this.result?.result.kind === 'exited') await this.verification.abandon();
    }
    await this.releaseCapacity(); this.released = true; this.forget?.(); return 'absent';
  }
  async close(): Promise<void> { if (!this.started) await this.release(this.input.request); }
}
