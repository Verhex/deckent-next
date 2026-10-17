import { createHash } from 'node:crypto';
import { z } from 'zod';
import { attemptIdentitySchema, sameAttemptIdentity, AUDIT_TRACKED_PATHS_MAX, type AttemptIdentity } from '#domain/index.js';
import { AttemptStoreError, type AttemptStore } from '#engine/core/attempts/index.js';

/** One lifted hit: the path, the rule it matched and the exact entry that lifted it (an `execution.secretGate` list entry or a declared dependency tree). */
export const workerTreeExclusionSchema = z.object({ path: z.string().min(1).max(4096), rule: z.string().min(1).max(600),
  by: z.string().regex(/^(?:allowPatternPaths|acknowledgedDenyPaths|dependencyTree):.{1,512}$/su) }).strict().readonly();
export type WorkerTreeExclusion = z.infer<typeof workerTreeExclusionSchema>;
/** S6 (owner 2026-10-15): the dispatched attempt's config exclusions, kept in the attempt journal so every Run card can show them. */
export const workerTreeExclusionRecordSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema, count: z.number().int().positive().safe(),
  entries: z.array(workerTreeExclusionSchema).min(1).max(AUDIT_TRACKED_PATHS_MAX).readonly() }).strict().readonly();
export type WorkerTreeExclusionRecord = z.infer<typeof workerTreeExclusionRecordSchema>;
export const workerTreeExclusionCommandId = (identity: AttemptIdentity) =>
  'worker-tree-excluded-' + createHash('sha256').update(JSON.stringify(attemptIdentitySchema.parse(identity))).digest('hex');

/** A journal receipt before the launch (no observation, no revision change of meaning); the same exclusions replay, different ones conflict. */
export async function recordWorkerTreeExclusions(store: AttemptStore, identity: AttemptIdentity, excluded: readonly WorkerTreeExclusion[]) {
  const record = workerTreeExclusionRecordSchema.parse({ schemaVersion: 1, identity, count: excluded.length, entries: excluded.slice(0, AUDIT_TRACKED_PATHS_MAX) });
  const command = JSON.stringify(record), commandId = workerTreeExclusionCommandId(identity);
  const replay = await store.receipt(identity.scopeId, commandId);
  if (replay) { if (replay.command !== command) throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT'); return; }
  const snapshot = await store.load(identity.scopeId, identity.attemptId);
  if (!snapshot || !sameAttemptIdentity(snapshot.identity, identity) || snapshot.lastObservation || snapshot.cancelRequested) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
  await store.commit({ commandId, command, snapshot, expectedRevision: snapshot.revision });
}
export async function readWorkerTreeExclusions(store: Pick<AttemptStore, 'receipt'>, identity: AttemptIdentity): Promise<WorkerTreeExclusionRecord | null> {
  const receipt = await store.receipt(identity.scopeId, workerTreeExclusionCommandId(identity)); if (!receipt) return null;
  let record;
  try { record = workerTreeExclusionRecordSchema.parse(JSON.parse(receipt.command)); } catch { throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT'); }
  if (!sameAttemptIdentity(record.identity, identity)) throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT');
  return record;
}
