import { identitySchema, type VerifiedPrincipal } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { sandboxRequestSchema, SupervisorError, type ExecutionSupervisor, type SandboxRequest } from '#engine/core/supervisor/index.js';
import { DispatchError, type DispatchRecord, type DispatchStore } from './port.js';
export interface DispatchAuthorization {
  authorize(action: 'execute' | 'release' | 'reconcile', request: SandboxRequest, principal: VerifiedPrincipal): Promise<void>;
}
export type DispatchOutcome = Readonly<{ kind: 'terminal'; record: DispatchRecord } | { kind: 'unresolved'; record: DispatchRecord }>;
/** Internal application execution entry. Composition supplies a trusted broker workspace, verifier,
 * policy, supervisor and process-owner identity. It does not expose arbitrary paths to public callers.
 */
export class DispatchApplication {
  private readonly owner: string;
  constructor(private readonly store: DispatchStore, private readonly supervisor: ExecutionSupervisor,
    private readonly verifier: PrincipalVerifier, private readonly authorization: DispatchAuthorization, owner: string) {
    this.owner = identitySchema.parse(owner);
  }
  private async admit(action: 'execute' | 'release' | 'reconcile', input: unknown, credential: unknown) {
    const request = sandboxRequestSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, request.identity.scopeId);
    await this.authorization.authorize(action, request, principal);
    return request;
  }
  async execute(input: unknown, credential?: unknown, signal?: AbortSignal): Promise<DispatchOutcome> {
    const request = await this.admit('execute', input, credential);
    if (signal?.aborted) throw new SupervisorError('SUPERVISOR_CANCELLED');
    const claim = { request, owner: this.owner };
    const claimed = await this.store.claimDispatch(claim);
    if (!claimed.acquired) return Object.freeze({ kind: claimed.record.terminal ? 'terminal' : 'unresolved', record: claimed.record });
    // A throw or unknown result deliberately leaves the durable claim unresolved. No retry launch.
    const result = await this.supervisor.execute(request, signal);
    if (result.result.kind !== 'exited') return Object.freeze({ kind: 'unresolved', record: claimed.record });
    const record = await this.store.finishDispatch(claim, { handle: result.handle, exitCode: result.result.exitCode, interrupted: result.interrupted });
    return Object.freeze({ kind: 'terminal', record });
  }
  async reconcile(input: unknown, credential?: unknown): Promise<DispatchOutcome> {
    const request = await this.admit('reconcile', input, credential);
    const current = await this.store.readDispatch(request);
    if (!current) throw new DispatchError('DISPATCH_NOT_ADMITTED');
    if (current.terminal) return Object.freeze({ kind: 'terminal', record: current });
    const observed = await this.supervisor.observe(request);
    if (observed.result.kind !== 'exited') return Object.freeze({ kind: 'unresolved', record: current });
    // Terminal evidence is settled under existing custody, not a new launch grant. Daemon inspection
    // cannot reconstruct whether an earlier CLI was interrupted, so retain that fact as unknown.
    const record = await this.store.finishDispatch({ request, owner: current.owner },
      { handle: observed.handle, exitCode: observed.result.exitCode, interrupted: null });
    return Object.freeze({ kind: 'terminal', record });
  }
  async release(input: unknown, credential?: unknown): Promise<void> {
    const request = await this.admit('release', input, credential);
    const record = await this.store.readDispatch(request);
    if (!record?.terminal) throw new DispatchError('DISPATCH_NOT_ADMITTED');
    // Caller must retain required artifacts first; release never deletes the durable dispatch fence.
    await this.supervisor.release(request);
  }
}
