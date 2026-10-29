import { sameAttemptIdentity } from '#domain/index.js';
import { SupervisorError, sameSandboxRequest, sandboxRequestSchema, type ExecutionSupervisor, type SupervisorProfileSource,
  type SandboxRequest, type SandboxResult, type CollectedOutputFile, type SupervisorLaunchHooks } from '#engine/core/supervisor/index.js';
import { assertBeuserAccess, type BeuserContext } from '#engine/core/beuser-contract/index.js';
import { assertBeuserRequestIdentity } from './admission.js';
import type { DispatchApplication } from '#engine/core/dispatch/index.js';

export interface BeuserSupervisorCustody {
  /** Trusted Run reservation/dispatch lookup, not a process-local PID table or public ingress. */
  context(request: SandboxRequest): Promise<BeuserContext>;
  request(context: BeuserContext): Promise<SandboxRequest>;
  /** Exact realm/nonce + immutable worker incarnation + handle, from the existing lifecycle owner. */
  attributed(context: BeuserContext, observation: Pick<SandboxResult, 'worker' | 'handle' | 'container'>): Promise<boolean>;
  /** C5 harness output, read only after the existing supervisor proves it terminal. No client-authored report. */
  collect(context: BeuserContext): Promise<readonly CollectedOutputFile[]>;
  refusal(context: BeuserContext): Promise<void>;
}
/** DispatchApplication remains the sole claim/launch/cancel/reconcile/replay and retained-output owner. */
export class BeuserExecutionSupervisor implements ExecutionSupervisor, SupervisorProfileSource {
  constructor(private readonly delegate: ExecutionSupervisor & SupervisorProfileSource, private readonly custody: BeuserSupervisorCustody) {}
  captureProfile() { return this.delegate.captureProfile(); }
  private async context(input: SandboxRequest, cleanup = false) {
    const request = sandboxRequestSchema.parse(input), admitted = await this.custody.context(request);
    // Cancellation/recovery must work after the walk's AbortSignal. Their caller already owns dispatch authority.
    const context = cleanup ? { ...admitted, signal: new AbortController().signal } : admitted;
    try {
      assertBeuserRequestIdentity(context, request.identity);
      if (!sameSandboxRequest(request, await this.custody.request(context))) throw new SupervisorError('SUPERVISOR_REQUEST_INVALID');
      assertBeuserAccess(context, context.binding, context.principal, { kind: 'attempt', id: request.identity.attemptId }, 'evaluate');
    } catch (error) { await this.custody.refusal(context); throw error; }
    return context;
  }
  private async observation<T extends Pick<SandboxResult, 'worker' | 'handle' | 'container'>>(context: BeuserContext, observed: T): Promise<T> {
    if (!await this.custody.attributed(context, observed)) { await this.custody.refusal(context); throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT'); }
    return observed;
  }
  async execute(request: SandboxRequest, signal?: AbortSignal, hooks?: SupervisorLaunchHooks) {
    const context = await this.context(request);
    return this.observation(context, await this.delegate.execute(request, AbortSignal.any([context.signal, ...(signal ? [signal] : [])]), hooks));
  }
  async observe(request: SandboxRequest) { return this.observation(await this.context(request, true), await this.delegate.observe(request)); }
  async cancel(request: SandboxRequest) { return this.observation(await this.context(request, true), await this.delegate.cancel(request)); }
  async recoverOutput(request: SandboxRequest) {
    await this.terminal(request);
    return this.delegate.recoverOutput(request);
  }
  async release(request: SandboxRequest) { await this.terminal(request); return this.delegate.release(request); }
  async collectOutputFiles(request: SandboxRequest): Promise<readonly CollectedOutputFile[]> {
    const context = await this.terminal(request), files = await this.custody.collect(context);
    let total = 0;
    for (const file of files) if (file.status === 'collected') total += file.bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > context.limits.maxArtifactBytes) throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    return files;
  }
  private async terminal(request: SandboxRequest) {
    const context = await this.context(request, true), observed = await this.observation(context, await this.delegate.observe(request));
    if (observed.result.kind !== 'exited') throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
    return context;
  }
  async observeTermination(request: SandboxRequest, worker: Parameters<NonNullable<ExecutionSupervisor['observeTermination']>>[1]) {
    const context = await this.context(request, true);
    const result = await this.delegate.observeTermination?.(request, worker) ?? null;
    if (result && (JSON.stringify(result.worker) !== JSON.stringify(worker) || !sameAttemptIdentity(context.binding.identity, request.identity))) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
    return result;
  }
  async observeCreatedAbsence(request: SandboxRequest, containerId: string) {
    await this.context(request, true);
    return this.delegate.observeCreatedAbsence?.(request, containerId) ?? null;
  }
  async removeCreatedContainer(request: SandboxRequest, containerId: string) {
    await this.context(request, true);
    return this.delegate.removeCreatedContainer?.(request, containerId) ?? 'not-created';
  }
}
export type BeuserDispatchPort = Pick<DispatchApplication, 'execute' | 'cancel' | 'reconcile' | 'recoverOutput' | 'release'>;
/** All durable replay/launch decisions stay inside the existing dispatch application. */
export class BeuserDispatch {
  constructor(private readonly dispatch: BeuserDispatchPort, private readonly refusal: (context: BeuserContext) => Promise<void>, private readonly request: (context: BeuserContext) => Promise<SandboxRequest>) {}
  private async guard(context: BeuserContext, request: SandboxRequest, cleanup: boolean) {
    const checked = cleanup ? { ...context, signal: new AbortController().signal } : context;
    try {
      assertBeuserRequestIdentity(checked, request.identity);
      if (!sameSandboxRequest(request, await this.request(checked))) throw new SupervisorError('SUPERVISOR_REQUEST_INVALID');
      assertBeuserAccess(checked, checked.binding, checked.principal, { kind: 'attempt', id: request.identity.attemptId }, 'evaluate');
    } catch (error) { await this.refusal(checked); throw error; }
  }
  async execute(context: BeuserContext, request: SandboxRequest, credential: unknown) {
    await this.guard(context, request, false); return this.dispatch.execute(request, credential, context.signal);
  }
  async cancel(context: BeuserContext, request: SandboxRequest, credential: unknown) {
    await this.guard(context, request, true); return this.dispatch.cancel(request, credential);
  }
  async reconcile(context: BeuserContext, request: SandboxRequest, credential: unknown) {
    await this.guard(context, request, true); return this.dispatch.reconcile(request, credential);
  }
  async recoverOutput(context: BeuserContext, request: SandboxRequest, credential: unknown) {
    await this.guard(context, request, true); return this.dispatch.recoverOutput(request, credential);
  }
  async release(context: BeuserContext, request: SandboxRequest, credential: unknown) {
    await this.guard(context, request, true); return this.dispatch.release(request, credential);
  }
}
