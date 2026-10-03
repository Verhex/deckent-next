import { createHash } from 'node:crypto';
import { z } from 'zod';
import { attemptIdentitySchema, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import { AttemptStoreError, type AttemptStore } from '#engine/core/attempts/index.js';
const eventSchema = z.object({ kind: z.enum(['handoff-received', 'workspace-started-from-patch']), source: attemptIdentitySchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();
export const handoffStartRecordSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  events: z.array(eventSchema).readonly() }).strict().readonly();
export type HandoffStartRecord = z.infer<typeof handoffStartRecordSchema>;
export type HandoffStartEvent = z.infer<typeof eventSchema>;
export const handoffEventCommandId = (identity: AttemptIdentity) => 'handoff-start-' + createHash('sha256').update(JSON.stringify(attemptIdentitySchema.parse(identity))).digest('hex');
export async function readAttemptHandoffEvents(store: Pick<AttemptStore, 'receipt'>, identity: AttemptIdentity): Promise<HandoffStartRecord | null> {
  const receipt = await store.receipt(identity.scopeId, handoffEventCommandId(identity)); if (!receipt) return null;
  let record;
  try { record = handoffStartRecordSchema.parse(JSON.parse(receipt.command)); } catch { throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT'); }
  if (!sameAttemptIdentity(record.identity, identity) || !sameAttemptIdentity(receipt.snapshot.identity, identity)
    || record.events.some(event => event.source.scopeId !== identity.scopeId || event.source.runId !== identity.runId || event.source.layoutRevision !== identity.layoutRevision)) throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT');
  return record;
}
/** A receipt in the existing event journal; does not alter supervisor observations, attempt revision or task acceptance. */
export async function recordAttemptHandoffStart(store: AttemptStore, identity: AttemptIdentity, events: readonly HandoffStartEvent[]) {
  if (!events.length) return;
  const record = handoffStartRecordSchema.parse({ schemaVersion: 1, identity, events });
  const command = JSON.stringify(record), commandId = handoffEventCommandId(identity);
  const replay = await store.receipt(identity.scopeId, commandId);
  if (replay) { if (replay.command !== command) throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT'); return; }
  const snapshot = await store.load(identity.scopeId, identity.attemptId);
  if (!snapshot || !sameAttemptIdentity(snapshot.identity, identity) || snapshot.lastObservation || snapshot.cancelRequested) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
  await store.commit({ commandId, command, snapshot, expectedRevision: snapshot.revision });
}
