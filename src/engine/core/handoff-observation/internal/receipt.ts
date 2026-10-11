import { createHash } from 'node:crypto';
import { z } from 'zod';
import { attemptIdentitySchema, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import { AttemptStoreError, type AttemptStore } from '#engine/core/attempts/index.js';
import { HandoffError } from './validation.js';
const eventSchema = z.object({ kind: z.enum(['handoff-received', 'workspace-started-from-patch']), source: attemptIdentitySchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().superRefine((event, ctx) => {
  if ((event.bindingDigest === undefined) !== (event.snapshotDigest === undefined)
    || (event.kind !== 'workspace-started-from-patch' && event.bindingDigest !== undefined))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid patch start digest pair' });
}).readonly();
export const handoffStartRecordSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  events: z.array(eventSchema).readonly() }).strict().superRefine((record, ctx) => {
  const patches = record.events.filter(event => event.kind === 'workspace-started-from-patch');
  if (patches.some(event => event.bindingDigest !== patches[0]?.bindingDigest || event.snapshotDigest !== patches[0]?.snapshotDigest))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent patch start digests' });
}).readonly();
export type HandoffStartRecord = z.infer<typeof handoffStartRecordSchema>;
export type HandoffStartEvent = z.infer<typeof eventSchema>;
/** The adapter's order is not authority; every receipt binds to the full source Attempt. */
export function bindPatchStartEvents(events: readonly HandoffStartEvent[], applied: {
  receipts: readonly { source: AttemptIdentity; digest: string }[]; bindingDigest?: string | undefined; snapshotDigest?: string | undefined;
}): readonly HandoffStartEvent[] {
  const patches = events.filter(event => event.kind === 'workspace-started-from-patch');
  if (applied.receipts.length !== patches.length || (patches.length && (!applied.bindingDigest || !applied.snapshotDigest))
    || patches.some((event, index) => patches.some((other, otherIndex) => otherIndex !== index && sameAttemptIdentity(event.source, other.source))))
    throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
  return events.map(event => {
    if (event.kind !== 'workspace-started-from-patch') return event;
    const matches = applied.receipts.filter(receipt => sameAttemptIdentity(receipt.source, event.source));
    if (matches.length !== 1 || matches[0]!.digest !== event.digest) throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
    return { ...event, bindingDigest: applied.bindingDigest, snapshotDigest: applied.snapshotDigest };
  });
}
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
export async function recordAttemptHandoffStart(store: AttemptStore, identity: AttemptIdentity, events: readonly HandoffStartEvent[], applied?: Parameters<typeof bindPatchStartEvents>[1]) {
  if (!events.length) return;
  const record = handoffStartRecordSchema.parse({ schemaVersion: 1, identity, events: applied ? bindPatchStartEvents(events, applied) : events });
  const command = JSON.stringify(record), commandId = handoffEventCommandId(identity);
  const replay = await store.receipt(identity.scopeId, commandId);
  if (replay) {
    // Alpha.28 journal bytes stay authoritative: only exact G2-less equality can replay, never backfill.
    const legacy = JSON.stringify({ ...record, events: record.events.map(({ bindingDigest: _binding, snapshotDigest: _snapshot, ...event }) => {
      void _binding; void _snapshot; return event;
    }) });
    if (replay.command !== command && replay.command !== legacy) throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT');
    return;
  }
  const snapshot = await store.load(identity.scopeId, identity.attemptId);
  if (!snapshot || !sameAttemptIdentity(snapshot.identity, identity) || snapshot.lastObservation || snapshot.cancelRequested) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
  await store.commit({ commandId, command, snapshot, expectedRevision: snapshot.revision });
}
