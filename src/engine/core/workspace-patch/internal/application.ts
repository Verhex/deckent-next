import { attemptIdentitySchema, sameAttemptIdentity, type AttemptIdentity, type TaskDefinition } from '#domain/index.js';
import type { ArtifactReceipt, ArtifactStore } from '#capabilities/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { DispatchClaim, DispatchRecord, RunBoundDispatchStore, DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { workspacePatchSchema, WorkspacePatchError, type WorkspacePatch } from './contract.js';
import { assertPatchScope, classifyPatchScope, type PatchScope, type PatchScopeMode } from './scope.js';
import type { AttemptCustodyReleaseApplication } from './custody.js';
/** Trusted lookup of the Run-bound task definition (the Run snapshot frozen at admission) after authorization; full identity binds. */
export interface RunBoundTaskStore { loadBoundTask(identity: AttemptIdentity): Promise<TaskDefinition> }
export interface WorkspacePatchStore extends RunBoundDispatchStore {
  retainDispatchPatch(claim: DispatchClaim, receipt: ArtifactReceipt): Promise<DispatchRecord>;
}
export interface WorkspacePatchSource {
  /** Check exact stopped worker custody both before and after bounded snapshot reads. */
  capture(record: DispatchRecord): Promise<WorkspacePatch>;
  /** EXEC-RELEASE: the stopped container or the clone is already gone (custody released), so only the retained patch can answer. */
  released?(record: DispatchRecord): Promise<boolean>;
}
export class WorkspacePatchApplication {
  /** `scopeMode` comes from the configured work target (K6; absent target or setting = warn), re-read per operation by composition. */
  constructor(private readonly store: RunBoundDispatchStore & RunBoundTaskStore, private readonly artifacts: ArtifactStore,
    private readonly verifier: PrincipalVerifier, private readonly authorization: DispatchIdentityAuthorization,
    private readonly maxBytes: number, private readonly scopeMode: PatchScopeMode,
    /** EXEC-RELEASE: owner of the custody release that follows this application's retain transition (absent = never released here). */
    private readonly custody?: Pick<AttemptCustodyReleaseApplication, 'release'>) {}
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
  private async scope(identity: AttemptIdentity, patch: WorkspacePatch): Promise<PatchScope> {
    const task = await this.store.loadBoundTask(identity);
    return classifyPatchScope(patch, task.workInput?.scope.paths ?? null, this.scopeMode);
  }
  /** K6 enforce gate: callers run it before their first durable delivery write (integration claim, delivery claim). */
  assertScope(scope: PatchScope) { assertPatchScope(scope); }
  async prepare(input: unknown, source: WorkspacePatchSource, writer: WorkspacePatchStore, credential?: unknown) {
    const { identity, record } = await this.admit(input, true, credential);
    let patch: WorkspacePatch;
    try { patch = this.validate(await source.capture(record), identity); }
    catch (error) {
      // A released (or concurrently released) attempt keeps only its retained patch: replay returns it verified, never a new capture.
      const current = await this.store.loadBoundDispatch(identity);
      if (!current?.patch || !(await source.released?.(current).catch(() => false))) throw error;
      const retained = await this.retained(identity, current.patch);
      return Object.freeze({ ...retained, ...(this.custody ? { custody: await this.custody.release(identity, current.patch, credential) } : {}) });
    }
    const scope = await this.scope(identity, patch);
    const bytes = Buffer.from(JSON.stringify(patch));
    if (bytes.length > this.maxBytes) throw new WorkspacePatchError('PATCH_LIMIT');
    const receipt = await this.artifacts.put(identity.scopeId, bytes);
    if (record.patch && JSON.stringify(record.patch) !== JSON.stringify(receipt)) throw new WorkspacePatchError('PATCH_CONFLICT');
    await writer.retainDispatchPatch({ request: record.request, owner: record.owner }, receipt);
    // The retained receipt is the required delivery artifact; only now may custody be released (typed outcome, never a thrown failure).
    const custody = this.custody ? { custody: await this.custody.release(identity, receipt, credential) } : {};
    return Object.freeze({ schemaVersion: 1 as const, receipt, patch, scope, application: 'not-applied' as const, ...custody });
  }
  private async retained(identity: AttemptIdentity, receipt: ArtifactReceipt) {
    if (receipt.byteLength > this.maxBytes) throw new WorkspacePatchError('PATCH_LIMIT');
    const bytes = await this.artifacts.read(identity.scopeId, receipt);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new WorkspacePatchError('PATCH_CORRUPT'); }
    const patch = this.validate(value, identity);
    return { schemaVersion: 1 as const, receipt, patch, scope: await this.scope(identity, patch), application: 'not-applied' as const };
  }
  async preview(input: unknown, credential?: unknown) {
    const { identity, record } = await this.admit(input, false, credential);
    if (!record.patch) throw new WorkspacePatchError('PATCH_UNAVAILABLE');
    return Object.freeze(await this.retained(identity, record.patch));
  }
}
