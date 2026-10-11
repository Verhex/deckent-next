import { z } from 'zod';
import { createHash } from 'node:crypto';
import { attemptIdentitySchema, attemptSnapshotSchema, verifiedPrincipalSchema, counterSchema, identitySchema,
  applyAttemptObservation, observeRunAttempt, sameAttemptIdentity, auditRecordSchema, type RunSnapshot, type AuditRecord, type AttemptSnapshot, type AttemptIdentity } from '#domain/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';
import { DispatchError, dispatchRecordSchema, type DispatchRecord } from './port.js';
import { dispatchFenceReceiptId } from './loss.js';

/** Trusted application write, not a public command. No release or terminal result is inferred. */
export const lostDispatchWriteSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  owner: identitySchema, expectedRunRevision: counterSchema, expectedAttemptRevision: counterSchema,
  actor: verifiedPrincipalSchema, reasonCode: identitySchema, now: counterSchema }).strict().readonly();
export type LostDispatchWrite = z.infer<typeof lostDispatchWriteSchema>;
/** Same immutable command/snapshot envelope as RunStore, without a reverse dependency on its application. */
export interface LostDispatchReceipt {
  readonly commandId: string;
  readonly command: string;
  readonly snapshot: RunSnapshot;
}
export type LostDispatchAudit = (store: AuditStore, snapshot: RunSnapshot) => AuditRecord;
export interface LostDispatchStore {
  fenceLostDispatch(write: LostDispatchWrite, audit: LostDispatchAudit): Promise<LostDispatchReceipt>;
  loadRunReceipt(scopeId: string, commandId: string): Promise<LostDispatchReceipt | null>;
  receipt(scopeId: string, commandId: string): Promise<Readonly<{ snapshot: AttemptSnapshot }> | null>;
}
export function encodeLostDispatchWrite(input: LostDispatchWrite) {
  const write = lostDispatchWriteSchema.parse(input);
  if (!write.actor.scopeIds.includes(write.identity.scopeId)) throw new DispatchError('DISPATCH_NOT_ADMITTED');
  const payload: { -readonly [K in keyof LostDispatchWrite]?: LostDispatchWrite[K] } = { ...write }; delete payload.now;
  return { write, commandId: dispatchFenceReceiptId(write.identity, write.owner),
    command: JSON.stringify({ operation: 'fence-lost-dispatch', ...payload }) };
}
/** Called only with rows read in the same BEGIN IMMEDIATE transaction as both CAS writes. */
export function proposeLostDispatchFence(run: RunSnapshot, row: { revision?: unknown; snapshot?: unknown } | undefined,
  record: DispatchRecord | null, write: LostDispatchWrite) {
  let current;
  try { current = attemptSnapshotSchema.parse(JSON.parse(String(row?.snapshot))); }
  catch { throw new DispatchError('DISPATCH_CORRUPT'); }
  if (current.revision !== row?.revision || !sameAttemptIdentity(current.identity, write.identity)) throw new DispatchError('DISPATCH_CORRUPT');
  if (!record || record.owner !== write.owner || !sameAttemptIdentity(record.request.identity, write.identity)
    || record.launch !== 'granted' || (record.terminal && current.lastObservation?.result.kind !== 'unknown')) throw new DispatchError('DISPATCH_CONFLICT');
  if (run.revision !== write.expectedRunRevision || current.revision !== write.expectedAttemptRevision) throw new DispatchError('DISPATCH_CONFLICT');
  const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, write.identity));
  const task = run.progress.find(value => value.taskId === write.identity.taskId);
  if (!binding || !task || !['active', 'reconciling'].includes(task.phase)) throw new DispatchError('DISPATCH_CONFLICT');
  const eventId = dispatchFenceReceiptId(write.identity, write.owner);
  const attempt = applyAttemptObservation(current, { protocolVersion: 1, identity: write.identity,
    sequence: (current.lastObservation?.sequence ?? 0) + 1, eventId,
    result: { kind: 'unknown', reasonCode: write.reasonCode } }, current.revision);
  return { attempt, snapshot: observeRunAttempt(run, run.revision, attempt) };
}
/** Audit records the reconciliation hold on this exact task, not an operator Run pause. */
export function assertLostDispatchAudit(input: unknown, snapshot: RunSnapshot, command: string, write: LostDispatchWrite): AuditRecord {
  const parsed = auditRecordSchema.safeParse(input);
  if (!parsed.success) throw new DispatchError('DISPATCH_CORRUPT');
  const { event } = parsed.data, subject = event.subject;
  if (event.scopeId !== write.identity.scopeId || event.eventId !== dispatchFenceReceiptId(write.identity, write.owner)
    || event.principal.issuer !== write.actor.issuer || event.principal.subject !== write.actor.subject || event.atMs !== write.now
    || subject.kind !== 'run-lifecycle' || subject.action !== 'hold' || subject.runId !== write.identity.runId
    || subject.taskId !== write.identity.taskId || subject.revision !== snapshot.revision || subject.commandId !== event.eventId
    || subject.inputDigest !== createHash('sha256').update(command).digest('hex')) throw new DispatchError('DISPATCH_CORRUPT');
  return parsed.data;
}
export function assertLostDispatchReplay(row: { command?: unknown; snapshot?: unknown } | undefined,
  replay: LostDispatchReceipt, write: LostDispatchWrite): void {
  if (!row || row.command !== replay.command) throw new DispatchError('DISPATCH_CORRUPT');
  const parsed = attemptSnapshotSchema.safeParse((() => { try { return JSON.parse(String(row.snapshot)); } catch { return null; } })());
  if (!parsed.success || !sameAttemptIdentity(parsed.data.identity, write.identity)
    || parsed.data.revision !== write.expectedAttemptRevision + 1 || parsed.data.lastObservation?.eventId !== replay.commandId
    || parsed.data.lastObservation.result.kind !== 'unknown' || parsed.data.lastObservation.result.reasonCode !== write.reasonCode
    || replay.snapshot.revision !== write.expectedRunRevision + 1
    || !replay.snapshot.bindings.some(binding => sameAttemptIdentity(binding.identity, write.identity)
      && binding.observedKind === 'unknown' && binding.observedRevision === parsed.data.revision)
    || !replay.snapshot.progress.some(task => task.taskId === write.identity.taskId && task.phase === 'reconciling' && task.unresolvedEffects)) {
    throw new DispatchError('DISPATCH_CORRUPT');
  }
}

/** Proposed generic Attempt-store guard; called inside its writer transaction, before command replay. */
export function attemptDispatchWriteToken(encoded: unknown, identity: AttemptIdentity, commandId: string) {
  let record;
  try { record = dispatchRecordSchema.parse(JSON.parse(String(encoded))); }
  catch { throw new DispatchError('DISPATCH_CORRUPT'); }
  if (!sameAttemptIdentity(record.request.identity, identity)) throw new DispatchError('DISPATCH_CONFLICT');
  const fenceId = dispatchFenceReceiptId(identity, record.owner);
  // Only the audited atomic writer may create the reserved fence receipt.
  if (commandId === fenceId) throw new DispatchError('DISPATCH_CONFLICT');
  return { record, fenceId };
}
