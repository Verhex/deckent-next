import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, attemptIdentitySchema, counterSchema, type AuditRecord, type DispatchLossDecision } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';
import { sandboxObservationSchema, type ExecutionSupervisor } from '#engine/core/supervisor/index.js';
import type { DispatchIdentityAuthorization } from './application.js';
import { DispatchError, type DispatchRecord, type RunBoundDispatchStore } from './port.js';
import { encodeLostDispatchWrite, lostDispatchWriteSchema, type LostDispatchStore, type LostDispatchReceipt } from './fence-write.js';
import { assessLostDispatch, dispatchFenceReceiptId } from './loss.js';

const commandSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  expectedRunRevision: counterSchema, expectedAttemptRevision: counterSchema }).strict();
/** Trusted observer resolves the stored supervisor profile and exact request. It never launches a worker. */
export interface LostDispatchObserver {
  observe(record: DispatchRecord): ReturnType<ExecutionSupervisor['observe']>;
}
type Recorder = (store: AuditStore) => { record(event: unknown): AuditRecord };
/** Internal reconciliation entry; no manual release command, heartbeat inference or automatic retry. */
export class LostDispatchApplication {
  constructor(private readonly store: LostDispatchStore & RunBoundDispatchStore, private readonly verifier: PrincipalVerifier,
    private readonly authorization: DispatchIdentityAuthorization, private readonly observer: LostDispatchObserver,
    private readonly recorder: Recorder, private readonly policyRevision: string, private readonly now: () => number) {}
  async fence(input: unknown, credential?: unknown): Promise<Readonly<{ receipt: LostDispatchReceipt; decision: DispatchLossDecision }>> {
    const command = commandSchema.parse(input), { identity } = command;
    const principal = await authenticate(this.verifier, credential, identity.scopeId);
    await this.authorization.authorizeIdentity('reconcile', identity, principal);
    const record = await this.store.loadBoundDispatch(identity);
    if (!record || record.launch !== 'granted') throw new DispatchError('DISPATCH_NOT_ADMITTED');
    const replay = await this.store.loadRunReceipt(identity.scopeId, dispatchFenceReceiptId(identity, record.owner));
    let reasonCode: string;
    if (replay) {
      try {
        const payload = JSON.parse(replay.command); delete payload.operation;
        reasonCode = lostDispatchWriteSchema.parse({ ...payload, now: this.now() }).reasonCode;
      } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
    } else {
      const observed = sandboxObservationSchema.parse(await this.observer.observe(record));
      if (observed.result.kind !== 'unknown') throw new DispatchError('DISPATCH_CONFLICT');
      reasonCode = observed.result.reasonCode;
    }
    const { write, commandId, command: encoded } = encodeLostDispatchWrite({ ...command, owner: record.owner,
      actor: principal, reasonCode, now: this.now() });
    const receipt = await this.store.fenceLostDispatch(write, (store, snapshot) => this.recorder(store).record({
      schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: commandId, scopeId: identity.scopeId,
      principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: this.policyRevision, atMs: write.now,
      subject: { kind: 'run-lifecycle', action: 'hold', runId: identity.runId, taskId: identity.taskId,
        commandId, revision: snapshot.revision, evidence: null, inputDigest: createHash('sha256').update(encoded).digest('hex') },
    }));
    const fence = await this.store.receipt(identity.scopeId, commandId);
    if (!fence || fence.snapshot.lastObservation?.eventId !== commandId) throw new DispatchError('DISPATCH_CORRUPT');
    const decision = assessLostDispatch(record, fence.snapshot, null, { identity, owner: record.owner, receiptId: commandId }, null);
    return Object.freeze({ receipt, decision });
  }
}
