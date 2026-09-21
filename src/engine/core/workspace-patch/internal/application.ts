import { attemptIdentitySchema, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import type { ArtifactReceipt, ArtifactStore } from '#capabilities/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { DispatchClaim, DispatchRecord, RunBoundDispatchStore, DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { workspacePatchSchema, WorkspacePatchError, type WorkspacePatch } from './contract.js';
export interface WorkspacePatchStore extends RunBoundDispatchStore {
  retainDispatchPatch(claim: DispatchClaim, receipt: ArtifactReceipt): Promise<DispatchRecord>;
}
export interface WorkspacePatchSource {
  /** Check exact stopped worker custody both before and after bounded snapshot reads. */
  capture(record: DispatchRecord): Promise<WorkspacePatch>;
}
export class WorkspacePatchApplication {
  constructor(private readonly store: RunBoundDispatchStore, private readonly artifacts: ArtifactStore,
    private readonly verifier: PrincipalVerifier, private readonly authorization: DispatchIdentityAuthorization,
    private readonly maxBytes: number) {}
  private async admit(input: unknown, preparing: boolean, credential?: unknown) {
    const identity = attemptIdentitySchema.parse(input);
    const principal = await authenticate(this.verifier, credential, identity.scopeId);
    await this.authorization.authorizeIdentity('read-output', identity, principal);
    if (preparing) await this.authorization.authorizeIdentity('recover-output', identity, principal);
    const record = await this.store.loadBoundDispatch(identity);
    if (!record?.terminal || !sameAttemptIdentity(identity, record.request.identity)) throw new WorkspacePatchError('PATCH_UNAVAILABLE');
    return { identity, record };
  }
  private validate(value: unknown, identity: AttemptIdentity) {
    const patch = workspacePatchSchema.safeParse(value);
    if (!patch.success || !sameAttemptIdentity(identity, patch.data.identity)) throw new WorkspacePatchError('PATCH_CORRUPT');
    return patch.data;
  }
  async prepare(input: unknown, source: WorkspacePatchSource, writer: WorkspacePatchStore, credential?: unknown) {
    const { identity, record } = await this.admit(input, true, credential);
    const patch = this.validate(await source.capture(record), identity);
    const bytes = Buffer.from(JSON.stringify(patch));
    if (bytes.length > this.maxBytes) throw new WorkspacePatchError('PATCH_LIMIT');
    const receipt = await this.artifacts.put(identity.scopeId, bytes);
    if (record.patch && JSON.stringify(record.patch) !== JSON.stringify(receipt)) throw new WorkspacePatchError('PATCH_CONFLICT');
    await writer.retainDispatchPatch({ request: record.request, owner: record.owner }, receipt);
    return Object.freeze({ schemaVersion: 1 as const, receipt, patch, application: 'not-applied' as const });
  }
  async preview(input: unknown, credential?: unknown) {
    const { identity, record } = await this.admit(input, false, credential);
    if (!record.patch) throw new WorkspacePatchError('PATCH_UNAVAILABLE');
    if (record.patch.byteLength > this.maxBytes) throw new WorkspacePatchError('PATCH_LIMIT');
    const bytes = await this.artifacts.read(identity.scopeId, record.patch);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new WorkspacePatchError('PATCH_CORRUPT'); }
    return Object.freeze({ schemaVersion: 1 as const, receipt: record.patch, patch: this.validate(value, identity), application: 'not-applied' as const });
  }
}
