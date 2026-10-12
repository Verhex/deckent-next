import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, attemptIdentitySchema, counterSchema, sameAttemptIdentity, releaseWorkerCustody, type AuditRecord, type DispatchLossDecision } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';
import { sandboxObservationSchema, type ExecutionSupervisor } from '#engine/core/supervisor/index.js';
import type { DispatchIdentityAuthorization } from './application.js';
import { DispatchError, type DispatchRecord, type RunBoundDispatchStore } from './port.js';
import { encodeLostDispatchWrite, type LostDispatchStore, dispatchReleaseReceiptId, type LostDispatchReceipt } from './fence-write.js';
import { assertDispatchFenceCommand } from './fence.js';
import { assessLostDispatch, dispatchFenceReceiptId } from './loss.js';

const commandSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  expectedRunRevision: counterSchema, expectedAttemptRevision: counterSchema }).strict();
/** Trusted observer resolves the stored supervisor profile and exact request. It never launches a worker. */
export interface LostDispatchObserver {
  observe(record: DispatchRecord): ReturnType<ExecutionSupervisor['observe']>;
  termination?(record: DispatchRecord): Promise<import('#engine/core/supervisor/index.js').SupervisorTermination | null>;
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
    let reasonCode: string; let retained;
    if (replay) {
      try {
        retained = assertDispatchFenceCommand(record, replay.command); reasonCode = retained.reasonCode;
      } catch (error) { if (error instanceof DispatchError) throw error; throw new DispatchError('DISPATCH_CORRUPT'); }
    } else {
      const observed = sandboxObservationSchema.parse(await this.observer.observe(record));
      if (observed.result.kind !== 'unknown') throw new DispatchError('DISPATCH_CONFLICT');
      reasonCode = observed.result.reasonCode;
    }
    const { write, commandId, command: encoded } = encodeLostDispatchWrite({ ...command, ...(retained ? { expectedRunRevision: retained.expectedRunRevision, expectedAttemptRevision: retained.expectedAttemptRevision } : {}), owner: record.owner,
      actor: retained?.actor ?? principal, reasonCode, now: this.now() });
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
  /** RESTART-RECOVERY: trusted termination observation only, never a caller proof or manual command. */
  async recover(input: unknown, credential?: unknown) {
    const command = commandSchema.parse(input), { identity } = command;
    const principal = await authenticate(this.verifier, credential, identity.scopeId);
    await this.authorization.authorizeIdentity('reconcile', identity, principal);
    const record = await this.store.loadBoundDispatch(identity);
    if (!record || !this.store.releaseLostDispatch) throw new DispatchError('DISPATCH_NOT_ADMITTED');
    const fenced = await this.fence(command, credential), commandId = dispatchReleaseReceiptId(identity, record.owner);
    const prior = await this.store.loadRunReceipt(identity.scopeId, commandId);
    let proof;
    if (prior) {
      let payload; try { payload = JSON.parse(prior.command); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
      if (payload?.operation !== 'release-worker-custody' || payload.owner !== record.owner || !attemptIdentitySchema.safeParse(payload.identity).success || !sameAttemptIdentity(payload.identity, identity)) throw new DispatchError('DISPATCH_FENCE_CONFLICT');
      proof = payload.proof;
    } else {
      const observed = record.worker ? await this.observer.termination?.(record) : null;
      if (!observed) return Object.freeze({ ...fenced, decision: { kind: 'hold-manual' as const, reason: 'termination-required' as const } });
      proof = { ...observed, identity, owner: record.owner, receiptId: commandId };
    }
    // A replayed fence pins historical evidence, not the Run revision after sibling progress.
    // Recheck current binding, fence and termination against the fresh snapshot; the writer repeats this under CAS.
    const current = await this.store.loadRun(identity.scopeId, identity.runId);
    const dispatch = await this.store.loadBoundDispatch(identity);
    if (!current || !dispatch) throw new DispatchError('DISPATCH_NOT_ADMITTED');
    const fence = { identity, owner: dispatch.owner, receiptId: fenced.receipt.commandId };
    if (dispatch.owner !== record.owner) throw new DispatchError('DISPATCH_FENCE_CONFLICT');
    if (!prior) releaseWorkerCustody(current, current.revision, { identity, owner: dispatch.owner, launch: dispatch.launch,
      lost: true, worker: dispatch.worker ?? null }, fence, proof);
    const write = { identity, owner: dispatch.owner, expectedRunRevision: current.revision, actor: principal, proof, now: this.now() };
    const encoded = JSON.stringify({ operation: 'release-worker-custody', identity, owner: record.owner, actor: principal, proof });
    const receipt = await this.store.releaseLostDispatch(write, (store, snapshot) => this.recorder(store).record({
      schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: commandId, scopeId: identity.scopeId,
      principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: this.policyRevision, atMs: write.now,
      subject: { kind: 'run-lifecycle', action: 'release-worker-custody', runId: identity.runId, taskId: identity.taskId,
        commandId, revision: snapshot.revision, evidence: null, inputDigest: createHash('sha256').update(encoded).digest('hex') },
    }));
    return Object.freeze({ receipt, decision: { kind: 'release' as const, fenceReceiptId: fenced.receipt.commandId, terminationReceiptId: commandId } });
  }

}
