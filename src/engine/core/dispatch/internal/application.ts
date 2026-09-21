import type { ArtifactStore } from '#capabilities/index.js';
import { retainOutput, retainRecoveredOutput, verifyRetainedOutput } from './output.js';
import { identitySchema, type CorePolicyAction, type AttemptIdentity, type VerifiedPrincipal } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { sandboxRequestSchema, sandboxResultSchema, sandboxObservationSchema, sandboxOutputSchema, SupervisorError, type ExecutionSupervisor, type SupervisorProfileSource, type SandboxRequest } from '#engine/core/supervisor/index.js';
import { DispatchError, type DispatchRecord, type DispatchStore } from './port.js';
export interface DispatchAuthorization {
  authorize(action: CorePolicyAction<'attempt'>, request: SandboxRequest, principal: VerifiedPrincipal): Promise<void>;
}
/** Same attempt action authority, usable before any stored execution request is read. */
export interface DispatchIdentityAuthorization {
  authorizeIdentity(action: CorePolicyAction<'attempt'>, identity: AttemptIdentity, principal: VerifiedPrincipal): Promise<void>;
}
export type DispatchOutcome = Readonly<{ kind: 'terminal'; record: DispatchRecord } | { kind: 'unresolved'; record: DispatchRecord } | { kind: 'prevented'; record: DispatchRecord }>;
/** Internal application execution entry. Composition supplies a trusted broker workspace, verifier,
 * policy, supervisor and process-owner identity. It does not expose arbitrary paths to public callers.
 */
export class DispatchApplication {
  private readonly owner: string;
  constructor(private readonly store: DispatchStore, private readonly supervisor: ExecutionSupervisor & SupervisorProfileSource,
    private readonly verifier: PrincipalVerifier, private readonly authorization: DispatchAuthorization, owner: string, private readonly artifacts: ArtifactStore,
    private readonly now: () => number = Date.now) {
    this.owner = identitySchema.parse(owner);
  }
  private async admit(action: CorePolicyAction<'attempt'>, input: unknown, credential: unknown) {
    const request = sandboxRequestSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, request.identity.scopeId);
    await this.authorization.authorize(action, request, principal);
    return { request, principal };
  }
  async execute(input: unknown, credential?: unknown, signal?: AbortSignal): Promise<DispatchOutcome> {
    const { request, principal } = await this.admit('execute', input, credential);
    if (signal?.aborted) throw new SupervisorError('SUPERVISOR_CANCELLED');
    const claim = { request, owner: this.owner };
    const existing = await this.store.readDispatch(request);
    if (existing) return Object.freeze({ kind: existing.launch === 'prevented-before-launch' ? 'prevented' : existing.terminal ? 'terminal' : 'unresolved', record: existing });
    const claimed = await this.store.claimDispatch({ ...claim, profile: await this.supervisor.captureProfile() });
    if (!claimed.acquired) return Object.freeze({ kind: claimed.record.launch === 'prevented-before-launch' ? 'prevented' : claimed.record.terminal ? 'terminal' : 'unresolved', record: claimed.record });
    const grant = await this.store.grantLaunch({ claim, principal, now: this.now() });
    if (grant.kind === 'prevented') return Object.freeze({ kind: 'prevented', record: grant.record });
    // A throw or unknown result deliberately leaves the durable claim unresolved. No retry launch.
    const result = sandboxResultSchema.parse(await this.supervisor.execute(request, signal));
    if (result.result.kind !== 'exited') return Object.freeze({ kind: 'unresolved', record: grant.record });
    const output = await retainOutput(this.artifacts, request, result, await this.supervisor.collectOutputFiles?.(request) ?? []);
    await this.store.retainDispatchOutput(claim, output);
    const record = await this.store.finishDispatch(claim, { handle: result.handle, exitCode: result.result.exitCode, ...(result.result.signal === undefined ? {} : { signal: result.result.signal }), interrupted: result.interrupted });
    return Object.freeze({ kind: 'terminal', record });
  }
  async reconcile(input: unknown, credential?: unknown): Promise<DispatchOutcome> {
    const { request } = await this.admit('reconcile', input, credential);
    const current = await this.store.readDispatch(request);
    if (!current) throw new DispatchError('DISPATCH_NOT_ADMITTED');
    if (current.launch === 'prevented-before-launch') return Object.freeze({ kind: 'prevented', record: current });
    if (current.terminal) return Object.freeze({ kind: 'terminal', record: current });
    if (current.launch === 'pending') return Object.freeze({ kind: 'unresolved', record: current });
    const observed = sandboxObservationSchema.parse(await this.supervisor.observe(request));
    if (observed.result.kind !== 'exited') return Object.freeze({ kind: 'unresolved', record: current });
    // Terminal evidence is settled under existing custody, not a new launch grant. Daemon inspection
    // cannot reconstruct whether an earlier CLI was interrupted, so retain that fact as unknown.
    const record = await this.store.finishDispatch({ request, owner: current.owner },
      { handle: observed.handle, exitCode: observed.result.exitCode, ...(observed.result.signal === undefined ? {} : { signal: observed.result.signal }), interrupted: null });
    return Object.freeze({ kind: 'terminal', record });
  }
  async authorizeCancellation(input: unknown, credential?: unknown): Promise<void> { await this.admit('cancel', input, credential); }
  async cancel(input: unknown, credential?: unknown): Promise<DispatchOutcome> {
    const { request, principal } = await this.admit('cancel', input, credential);
    const current = await this.store.requestDispatchCancellation(request, principal);
    if (current.launch === 'prevented-before-launch') return Object.freeze({ kind: 'prevented', record: current });
    if (current.terminal) return Object.freeze({ kind: 'terminal', record: current });
    if (current.launch === 'pending') {
      const decision = await this.store.grantLaunch({ claim: { request, owner: current.owner }, principal, now: this.now() });
      return Object.freeze({ kind: decision.kind === 'prevented' ? 'prevented' : 'unresolved', record: decision.record });
    }
    const observed = sandboxObservationSchema.parse(await this.supervisor.cancel(request));
    if (observed.result.kind !== 'exited') return Object.freeze({ kind: 'unresolved', record: current });
    const record = await this.store.finishDispatch({ request, owner: current.owner },
      { handle: observed.handle, exitCode: observed.result.exitCode, ...(observed.result.signal === undefined ? {} : { signal: observed.result.signal }), interrupted: null });
    return Object.freeze({ kind: 'terminal', record });
  }
  async recoverOutput(input: unknown, credential?: unknown): Promise<DispatchRecord> {
    const { request } = await this.admit('recover-output', input, credential);
    const current = await this.store.readDispatch(request);
    if (!current?.terminal) throw new DispatchError('DISPATCH_NOT_ADMITTED');
    if (current.output) return current;
    const output = sandboxOutputSchema.parse(await this.supervisor.recoverOutput(request));
    const receipt = await retainRecoveredOutput(this.artifacts, request, { stdout: output.stdout, stderr: output.stderr }, await this.supervisor.collectOutputFiles?.(request) ?? []);
    return this.store.retainDispatchOutput({ request, owner: current.owner }, receipt);
  }
  async release(input: unknown, credential?: unknown): Promise<void> {
    const { request } = await this.admit('release', input, credential);
    const record = await this.store.readDispatch(request);
    if (!record?.terminal) throw new DispatchError('DISPATCH_NOT_ADMITTED');
    await verifyRetainedOutput(this.artifacts, record);
    // Artifact verification is mandatory; releasing the container never deletes the durable fence.
    await this.supervisor.release(request);
  }
}
