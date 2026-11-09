import { patchBody, unifiedDiff, redactForRecord, EMPTY_KNOWN_SECRETS, type KnownSecretSnapshot } from '#platform/index.js';
import type { AttemptIdentity, RunSnapshot } from '#domain/index.js';
import type { DeliveryChangeFacts } from '#engine/core/delivery-summary/index.js';
import type { WorkspacePatch } from './contract.js';
import type { PatchScope } from './scope.js';
export function patchChangeDigests(patch: Pick<WorkspacePatch, 'changes'>, direction: 'forward' | 'reverse') {
  return patch.changes.map(change => { const [before, after] = direction === 'forward' ? [change.before, change.after] : [change.after, change.before];
    return { path: change.path, before: before?.digest ?? null, after: after?.digest ?? null }; });
}

/** Bounded line counts, not content. Exact changed paths and file modes are represented by the patch. */
function patchLineCounts(patch?: Pick<WorkspacePatch, 'changes'>) {
  let added = 0, removed = 0;
  for (const change of patch?.changes ?? []) {
    const { before, after, body: diff } = patchBody(change, unifiedDiff), body = diff.split('\n').slice(2);
    // The bounded renderer declines a large comparison: count it as a full replacement (over-states the risk, never under-states it, and
    // never blocks a delivery the way an error here would).
    if (body.some(line => line.startsWith('@@') && !/^@@ -[0-9]+,[0-9]+ \+[0-9]+,[0-9]+ @@$/.test(line))) {
      const lines = (text: string | null) => text === null || text === '' ? 0 : text.split('\n').length;
      added += lines(after); removed += lines(before); continue;
    }
    added += body.filter(line => line.startsWith('+')).length;
    removed += body.filter(line => line.startsWith('-')).length;
  }
  return { added, removed };
}
/** The workspace target's fill of the DeliverySummary `change` section: every changed path, +/− and the K6 scope classification (with G1's
 * instruction-surface writes). */
export function workspacePatchChangeFacts(patch: Pick<WorkspacePatch, 'changes'>, scope: PatchScope): DeliveryChangeFacts {
  return Object.freeze({ adapter: 'workspace-patch', paths: Object.freeze(patch.changes.map(change => change.path)), ...patchLineCounts(patch),
    scope: scope.status, outOfScope: scope.status === 'unscoped' ? Object.freeze([]) : scope.outOfScope,
    ...(scope.instructionSurface ? { instructionSurface: scope.instructionSurface } : {}) });
}
export function deliverySummary(run: RunSnapshot, identity: AttemptIdentity, patch?: WorkspacePatch, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS) {
  const task = run.graph.tasks.find(task => task.id === identity.taskId);
  const progress = run.progress.find(task => task.taskId === identity.taskId);
  const phase = progress?.phase ?? 'pending';
  const title = redactForRecord(task?.workInput?.title ?? identity.taskId, known).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 256);
  const { added, removed } = patchLineCounts(patch);
  return { title, acceptance: { phase, criteria: task?.acceptanceCriteria.length ?? 0, runRevision: run.revision, modelUnverified: progress?.acceptedEvidence === 'model-unverified' },
    files: patch?.changes.map(change => change.path) ?? [], added, removed };
}
