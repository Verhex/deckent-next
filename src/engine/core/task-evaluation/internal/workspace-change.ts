import { sameAttemptIdentity, TaskEvaluationError, type AttemptIdentity, type WorkInput } from '#domain/index.js';
import type { ArtifactStore } from '#capabilities/index.js';
import type { DispatchRecord } from '#engine/core/dispatch/index.js';
import { workspacePatchSchema } from '#engine/core/workspace-patch/index.js';
import { TaskEvidenceError } from './evidence.js';
/** Coding acceptance consumes the same immutable patch used for delivery. Missing/unreadable evidence is never an empty patch. */
export async function readWorkspaceChange(input: WorkInput | undefined, identity: AttemptIdentity, dispatch: DispatchRecord,
  artifacts: Pick<ArtifactStore, 'read'>, maxBytes: number) {
  if (!input) return undefined;
  const receipt = dispatch.patch;
  if (!receipt) throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
  if (receipt.scopeId !== identity.scopeId || receipt.byteLength > maxBytes) throw new TaskEvidenceError('TASK_EVIDENCE_INVALID');
  try {
    const patch = workspacePatchSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.read(identity.scopeId, receipt))));
    if (!sameAttemptIdentity(patch.identity, identity)) throw new Error();
    return { schemaVersion: 1 as const, patchDigest: receipt.digest, changedFiles: patch.changes.length };
  } catch { throw new TaskEvidenceError('TASK_EVIDENCE_INVALID'); }
}
