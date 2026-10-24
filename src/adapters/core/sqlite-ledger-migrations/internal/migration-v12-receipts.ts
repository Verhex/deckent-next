import { sameAttemptIdentity, type RunSnapshot } from '#domain/index.js';
import { AttemptStoreError, runCancellationSchema, runCreateSchema, runProjectionSchema, runReservationSchema,
  taskEvaluationCommitSchema } from '#engine/index.js';

function invalid(): never { throw new AttemptStoreError('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); }
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  return input as Record<string, unknown>;
}
function decode(input: unknown): Record<string, unknown> {
  if (typeof input !== 'string') return invalid();
  try { return record(JSON.parse(input)); } catch { return invalid(); }
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function common(commandId: unknown, parsedId: string, scopeId: string, runId: string, snapshot: RunSnapshot): void {
  if (typeof commandId !== 'string' || parsedId !== commandId || scopeId !== snapshot.identity.scopeId || runId !== snapshot.identity.runId) invalid();
}

/** Pure evidence validation for the closed set of Run receipt commands that schema 11 could write.
 * This proves command/snapshot identity and revision relationships, not full transition replay. */
export function requireMigrationReceipt(commandRaw: unknown, commandId: unknown, snapshot: RunSnapshot): void {
  try {
    const decoded = decode(commandRaw), action = decoded['action'], payload = { ...decoded };
    delete payload['action'];
    switch (action) {
      case 'create-run': {
        const command = runCreateSchema.parse(payload);
        common(commandId, command.commandId, command.identity.scopeId, command.identity.runId, snapshot);
        if (snapshot.revision !== 0 || !same(command.identity, snapshot.identity)
          || !same(command.graph, snapshot.graph) || !same(command.execution, snapshot.execution)) invalid();
        return;
      }
      case 'reserve-run-tasks': {
        const command = runReservationSchema.parse(payload);
        common(commandId, command.commandId, command.scopeId, command.runId, snapshot);
        if (new Set(command.identities.map(identity => `${identity.scopeId}\0${identity.runId}\0${identity.taskId}\0${identity.attemptId}\0${identity.generation}`)).size
          !== command.identities.length) invalid();
        if (snapshot.revision !== command.expectedRevision + 1 || !Number.isSafeInteger(snapshot.revision)) invalid();
        for (const identity of command.identities) {
          const binding = snapshot.bindings.find(candidate => sameAttemptIdentity(candidate.identity, identity));
          const progress = snapshot.progress.find(candidate => candidate.taskId === identity.taskId);
          if (identity.scopeId !== snapshot.identity.scopeId || identity.runId !== snapshot.identity.runId
            || identity.layoutRevision !== snapshot.identity.layoutRevision
            || !binding || binding.observedRevision !== null || binding.observedKind !== null || progress?.phase !== 'active') invalid();
        }
        return;
      }
      case 'project-run-attempt': {
        const command = runProjectionSchema.parse(payload);
        common(commandId, command.commandId, command.scopeId, command.runId, snapshot);
        const binding = snapshot.bindings.find(candidate => candidate.identity.attemptId === command.attemptId);
        if (snapshot.revision !== command.expectedRevision + 1 || !Number.isSafeInteger(snapshot.revision)
          || !binding || binding.identity.scopeId !== snapshot.identity.scopeId || binding.identity.runId !== snapshot.identity.runId
          || binding.identity.layoutRevision !== snapshot.identity.layoutRevision || binding.observedRevision === null) invalid();
        return;
      }
      case 'cancel-run': {
        const command = runCancellationSchema.parse(payload);
        common(commandId, command.commandId, command.scopeId, command.runId, snapshot);
        if (!snapshot.cancelRequested || (snapshot.revision !== command.expectedRevision
          && snapshot.revision !== command.expectedRevision + 1) || !Number.isSafeInteger(snapshot.revision)) invalid();
        return;
      }
      case 'apply-task-evaluation': {
        const command = taskEvaluationCommitSchema.parse(payload), identity = command.evaluation.identity;
        common(commandId, command.commandId, identity.scopeId, identity.runId, snapshot);
        const conclusion = command.evaluation.criteria.some(criterion => criterion.verdict === 'fail') ? 'failed'
          : command.evaluation.criteria.some(criterion => criterion.verdict === 'unknown') ? 'evaluating' : 'accepted';
        if (snapshot.revision !== command.expectedRevision + 1 || !Number.isSafeInteger(snapshot.revision)
          || identity.layoutRevision !== snapshot.identity.layoutRevision
          || !snapshot.bindings.some(binding => sameAttemptIdentity(binding.identity, identity))
          || snapshot.progress.find(progress => progress.taskId === identity.taskId)?.phase !== conclusion
          || !same(command.dispatch.request.identity, identity)) invalid();
        return;
      }
      default: invalid();
    }
  } catch (error) {
    if (error instanceof AttemptStoreError && error.code === 'LEDGER_MIGRATION_EVIDENCE_REQUIRED') throw error;
    invalid();
  }
}
