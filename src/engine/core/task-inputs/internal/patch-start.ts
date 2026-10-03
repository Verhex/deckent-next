import { attemptIdentitySchema, runSnapshotSchema, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import type { ArtifactStore, ArtifactReceipt } from '#capabilities/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { RunBoundDispatchStore, DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { selectReservedTaskProfile, type RunStore } from '#engine/core/runs/index.js';
import type { AttemptStore } from '#engine/core/attempts/index.js';
import { workspacePatchSchema, patchDigest, type WorkspacePatch } from '#engine/core/workspace-patch/index.js';
import { HandoffError } from '#engine/core/handoff-observation/index.js';
export interface AcceptedPredecessorPatch { readonly source: AttemptIdentity; readonly receipt: ArtifactReceipt; readonly patch: WorkspacePatch }
/** Reuses the frozen graph and accepted exact Run binding. Artifact existence never grants acceptance. */
export class TaskPatchStartApplication {
  constructor(private readonly store: Pick<RunStore, 'loadRun'> & Pick<AttemptStore, 'load'> & RunBoundDispatchStore,
    private readonly artifacts: ArtifactStore, private readonly verifier: PrincipalVerifier,
    private readonly authorization: DispatchIdentityAuthorization, private readonly maxBytes: number) {}
  async resolve(input: AttemptIdentity, credential?: unknown): Promise<readonly AcceptedPredecessorPatch[]> {
    const identity = attemptIdentitySchema.parse(input);
    const principal = await authenticate(this.verifier, credential, identity.scopeId);
    await this.authorization.authorizeIdentity('execute', identity, principal);
    const run = runSnapshotSchema.parse(await this.store.loadRun(identity.scopeId, identity.runId));
    selectReservedTaskProfile(run, await this.store.load(identity.scopeId, identity.attemptId), identity);
    const task = run.graph.tasks.find(value => value.id === identity.taskId)!;
    const starts = task.dependencies.filter(edge => typeof edge !== 'string' && edge.startFrom === 'accepted-patch');
    const result: AcceptedPredecessorPatch[] = []; let remaining = this.maxBytes;
    for (const edge of starts) {
      if (typeof edge === 'string') continue;
      const source = run.bindings.find(binding => binding.identity.taskId === edge.taskId)?.identity;
      if (!source || run.progress.find(value => value.taskId === edge.taskId)?.phase !== 'accepted') throw new HandoffError('HANDOFF_SOURCE_NOT_ACCEPTED');
      await this.authorization.authorizeIdentity('read-output', source, principal);
      const record = await this.store.loadBoundDispatch(source);
      if (!record?.patch || !record.terminal || !sameAttemptIdentity(record.request.identity, source)) throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
      const receipt = record.patch;
      if (receipt.scopeId !== identity.scopeId || receipt.byteLength > remaining) throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
      remaining -= receipt.byteLength;
      try {
        const bytes = await this.artifacts.read(identity.scopeId, receipt);
        if (bytes.byteLength !== receipt.byteLength || patchDigest(bytes) !== receipt.digest) throw new HandoffError('HANDOFF_ARTIFACT_MISMATCH');
        const patch = workspacePatchSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        if (!sameAttemptIdentity(patch.identity, source)) throw new HandoffError('HANDOFF_ARTIFACT_MISMATCH');
        result.push(Object.freeze({ source, receipt, patch }));
      } catch (error) {
        if (error instanceof HandoffError) throw error;
        throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
      }
    }
    return Object.freeze(result);
  }
}
