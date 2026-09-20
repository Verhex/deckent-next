import { invocationControl, writeInvocationControl } from './control.js';
import { purgeInvocationContent } from './purge.js';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { identitySchema, modelInvocationClaimSchema, parseModelInvocationControlRecord, parseModelInvocationCancellationReceipt, proposeModelInvocationSendPermission,
  type ModelInvocationClaim, type ModelInvocationNativeResponse,
  type ModelInvocationResponseEvidence, type ModelInvocationUnknownReason } from '#domain/index.js';
import { parseModelInvocationCancellationAdmission, createModelInvocationPreventedRecord, type ModelInvocationCancellationAdmission, ModelInvocationStoreError, parseModelInvocationAdmission, sameModelInvocationRequest,
  verifyModelInvocationRecord, createModelInvocationClaimReceipt,
  createModelInvocationResponseRecord, createModelInvocationEvidenceRecord, createModelInvocationUnknownRecord, type ModelInvocationRecord, parseModelInvocationPurgeAdmission, type ModelInvocationPurgeAdmission, type ModelInvocationAdmission, type ModelInvocationClaimResult,
  type ModelInvocationStore, verifyModelActivationRecord } from '#engine/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';
import { decodeInvocationRecord, invocationCommandRow, invocationIdentity, invocationRow, loadInvocationRecord } from './read.js';

type Row = Readonly<Record<string, unknown>>;
const allocationSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, allocationId: identitySchema,
  maxCalls: z.number().int().positive().safe(), maxInFlight: z.number().int().positive().safe(),
  lifetimeCalls: z.number().int().nonnegative().safe(), inFlight: z.number().int().nonnegative().safe() }).strict().readonly();
type Allocation = z.infer<typeof allocationSchema>;
const encoded = (value: unknown) => JSON.stringify(value);
const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right);

export class SqliteModelInvocationStore implements ModelInvocationStore {
  constructor(private readonly db: DatabaseSync) {}

  private fail(error: unknown): never {
    if (error instanceof ModelInvocationStoreError) throw error;
    sqliteFailure(error);
    throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
  }
  private transaction<T>(work: () => T): T {
    let active = false; let commitAttempted = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); active = true;
      const result = work(); commitAttempted = true; this.db.exec('COMMIT'); active = false; return result;
    } catch (error) {
      if (active) {
        try { this.db.exec('ROLLBACK'); active = false; }
        catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_OUTCOME_UNKNOWN'); }
      }
      if (commitAttempted) throw new ModelInvocationStoreError('MODEL_INVOCATION_OUTCOME_UNKNOWN');
      return this.fail(error);
    }
  }
  async loadReceipt(scopeInput: string, commandInput: string): Promise<ModelInvocationRecord | null> {
    try { const scopeId = invocationIdentity(scopeInput), commandId = invocationIdentity(commandInput);
      return decodeInvocationRecord(invocationCommandRow(this.db, scopeId, commandId), scopeId, commandId, 'command_id'); }
    catch (error) { return this.fail(error); }
  }
  async loadInvocation(scopeInput: string, invocationInput: string): Promise<ModelInvocationRecord | null> {
    try { return loadInvocationRecord(this.db, scopeInput, invocationInput); }
    catch (error) { return this.fail(error); }
  }
  private allocation(scopeId: string, allocationId: string): Allocation | null {
    const row = this.db.prepare(`SELECT scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record
      FROM model_invocation_allocations WHERE scope_id=? AND allocation_id=?`).get(scopeId, allocationId) as Row | undefined;
    if (!row) {
      const invocation = this.db.prepare(`SELECT 1 AS found FROM model_invocations
        WHERE scope_id=? AND allocation_id=? LIMIT 1`).get(scopeId, allocationId);
      if (invocation) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      return null;
    }
    try {
      if (typeof row['record'] !== 'string') throw new Error();
      const record = allocationSchema.parse(JSON.parse(row['record']));
      if (row['scope_id'] !== scopeId || row['allocation_id'] !== allocationId || row['max_calls'] !== record.maxCalls
        || row['max_in_flight'] !== record.maxInFlight || row['lifetime_calls'] !== record.lifetimeCalls
        || row['in_flight'] !== record.inFlight || record.scopeId !== scopeId || record.allocationId !== allocationId
        || record.inFlight > record.lifetimeCalls || record.lifetimeCalls > record.maxCalls || record.inFlight > record.maxInFlight) throw new Error();
      const observed = this.db.prepare(`SELECT count(*) AS lifetime_calls,
        sum(CASE WHEN state IN ('responded','rejected','not-sent') THEN 0 ELSE 1 END) AS in_flight
        FROM model_invocations WHERE scope_id=? AND allocation_id=?`).get(scopeId, allocationId);
      if (observed?.lifetime_calls !== record.lifetimeCalls || (observed?.in_flight ?? 0) !== record.inFlight) throw new Error();
      return record;
    } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
  }
  async claim(input: ModelInvocationAdmission): Promise<ModelInvocationClaimResult> {
    try {
      const admission = parseModelInvocationAdmission(input), { command, profile } = admission;
      return this.transaction(() => {
        const prior = decodeInvocationRecord(invocationCommandRow(this.db, command.scopeId, command.commandId), command.scopeId, command.commandId, 'command_id');
        if (prior) {
          if (!sameModelInvocationRequest(prior.receipt, command, admission.requestDigest, admission.actor)) {
            throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
          }
          return Object.freeze({ replayed: true, record: prior });
        }
        if (invocationRow(this.db, command.scopeId, admission.invocationId)) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
        const activationRow = this.db.prepare(`SELECT scope_id,provider_id,provider_version,model_id,model_version,revision,record
          FROM model_activations WHERE scope_id=? AND provider_id=? AND provider_version=? AND model_id=? AND model_version=?`)
          .get(command.scopeId, command.reference.providerId, command.reference.providerVersion,
            command.reference.modelId, command.reference.modelVersion) as Row | undefined;
        try {
          if (!activationRow || typeof activationRow['record'] !== 'string') throw new Error();
          const persisted = verifyModelActivationRecord(JSON.parse(activationRow['record']));
          const supplied = verifyModelActivationRecord(admission.activation);
          if (activationRow['scope_id'] !== command.scopeId || activationRow['provider_id'] !== command.reference.providerId
            || activationRow['provider_version'] !== command.reference.providerVersion || activationRow['model_id'] !== command.reference.modelId
            || activationRow['model_version'] !== command.reference.modelVersion || activationRow['revision'] !== persisted.revision
            || persisted.state !== 'active' || !same(persisted, supplied) || persisted.binding.digest !== admission.profile.bindingDigest) throw new Error();
        } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_ACTIVATION_CONFLICT'); }
        const configured = profile.allocation, current = this.allocation(command.scopeId, configured.id);
        if (current && (current.maxCalls !== configured.maxCalls || current.maxInFlight !== configured.maxInFlight)) {
          throw new ModelInvocationStoreError('MODEL_INVOCATION_ALLOCATION_CONFLICT');
        }
        const before = current ?? allocationSchema.parse({ schemaVersion: 1, scopeId: command.scopeId, allocationId: configured.id,
          maxCalls: configured.maxCalls, maxInFlight: configured.maxInFlight, lifetimeCalls: 0, inFlight: 0 });
        if (before.lifetimeCalls >= before.maxCalls) throw new ModelInvocationStoreError('MODEL_INVOCATION_QUOTA_EXHAUSTED');
        if (before.inFlight >= before.maxInFlight) throw new ModelInvocationStoreError('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
        const after = allocationSchema.parse({ ...before, lifetimeCalls: before.lifetimeCalls + 1, inFlight: before.inFlight + 1 });
        if (current) {
          const updated = this.db.prepare(`UPDATE model_invocation_allocations SET lifetime_calls=?,in_flight=?,record=?
          WHERE scope_id=? AND allocation_id=? AND lifetime_calls=? AND in_flight=?`)
          .run(after.lifetimeCalls, after.inFlight, encoded(after), command.scopeId, configured.id, before.lifetimeCalls, before.inFlight);
          if (updated.changes !== 1) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
        } else this.db.prepare(`INSERT INTO model_invocation_allocations(scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record)
          VALUES(?,?,?,?,?,?,?)`).run(command.scopeId, configured.id, after.maxCalls, after.maxInFlight, after.lifetimeCalls, after.inFlight, encoded(after));
        const receipt = createModelInvocationClaimReceipt(admission);
        const record = encoded(receipt);
        this.db.prepare('INSERT INTO model_invocations(scope_id,command_id,invocation_id,allocation_id,state,record) VALUES(?,?,?,?,?,?)')
          .run(command.scopeId, command.commandId, admission.invocationId, profile.allocation.id, 'claimed', record);
        const control = parseModelInvocationControlRecord({ schemaVersion: 1, claim: receipt.claim, reference: receipt.request.reference,
          send: { state: 'pending' }, cancellation: null });
        this.db.prepare(`INSERT INTO model_invocation_controls(scope_id,invocation_id,send_state,record) VALUES(?,?,?,?)`)
          .run(command.scopeId, admission.invocationId, 'pending', encoded(control));
        return Object.freeze({ replayed: false, record: verifyModelInvocationRecord({ receipt, content: null, purge: null }) });
      });
    } catch (error) { return this.fail(error); }
  }
  private settle(claimInput: ModelInvocationClaim, build: (record: ModelInvocationRecord) => ModelInvocationRecord): ModelInvocationRecord {
    const parsed = modelInvocationClaimSchema.parse(claimInput);
    return this.transaction(() => {
      const current = decodeInvocationRecord(invocationRow(this.db, parsed.scopeId, parsed.invocationId), parsed.scopeId, parsed.invocationId, 'invocation_id');
      if (!current || !same(current.receipt.claim, parsed)) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
      const allocation = this.allocation(current.receipt.request.scopeId, current.receipt.profile.allocation.id);
      const next = verifyModelInvocationRecord(build(current));
      if (current.receipt.outcome) {
        if (!same(current, next)) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
        return current;
      }
      const control = invocationControl(this.db, current);
      if (control.send.state !== 'permitted' && control.send.state !== 'unobserved') {
        throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
      }
      this.persistOutcome(current, next, allocation);
      return next;
    });
  }
  private persistOutcome(current: ModelInvocationRecord, next: ModelInvocationRecord, allocation: Allocation | null): void {
    if (!next.receipt.outcome || !same({ ...next.receipt, outcome: null }, current.receipt)) {
      throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    }
    if (!allocation || allocation.inFlight < 1) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    const outcome = next.receipt.outcome;
    if (outcome.state === 'responded' || outcome.state === 'rejected' || outcome.state === 'not-sent') {
      const after = allocationSchema.parse({ ...allocation, inFlight: allocation.inFlight - 1 });
      const updated = this.db.prepare(`UPDATE model_invocation_allocations SET in_flight=?,record=?
        WHERE scope_id=? AND allocation_id=? AND lifetime_calls=? AND in_flight=?`)
        .run(after.inFlight, encoded(after), allocation.scopeId, allocation.allocationId, allocation.lifetimeCalls, allocation.inFlight);
      if (updated.changes !== 1) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    }
    if (next.content) this.db.prepare(`INSERT INTO model_invocation_contents(scope_id,invocation_id,record) VALUES(?,?,?)`)
      .run(current.receipt.claim.scopeId, current.receipt.claim.invocationId, encoded(next.content));
    const updated = this.db.prepare(`UPDATE model_invocations SET state=?,record=? WHERE scope_id=? AND invocation_id=? AND state='claimed'`)
      .run(outcome.state, encoded(next.receipt), current.receipt.claim.scopeId, current.receipt.claim.invocationId);
    if (updated.changes !== 1) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  }
  async loadControl(scopeId: string, invocationId: string) {
    try { return this.transaction(() => { const record = loadInvocationRecord(this.db, scopeId, invocationId);
      return record ? invocationControl(this.db, record) : null; }); }
    catch (error) { return this.fail(error); }
  }
  async permitSend(claimInput: ModelInvocationClaim, ownerId: string, now: number) {
    try {
      const claim = modelInvocationClaimSchema.parse(claimInput);
      return this.transaction(() => {
        const record = loadInvocationRecord(this.db, claim.scopeId, claim.invocationId);
        if (!record || !same(record.receipt.claim, claim)) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
        const current = invocationControl(this.db, record);
        if (!this.allocation(claim.scopeId, record.receipt.profile.allocation.id)) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
        const proposal = proposeModelInvocationSendPermission(current, ownerId, now);
        if (proposal.granted) writeInvocationControl(this.db, current, proposal.record);
        return Object.freeze({ granted: proposal.granted, control: proposal.record, record });
      });
    } catch (error) { return this.fail(error); }
  }
  async cancelInvocation(input: ModelInvocationCancellationAdmission) {
    try {
      const admission = parseModelInvocationCancellationAdmission(input), { command, actor } = admission;
      return this.transaction(() => {
        const current = decodeInvocationRecord(invocationCommandRow(this.db, command.scopeId, command.targetCommandId),
          command.scopeId, command.targetCommandId, 'command_id');
        if (!current || !same(current.receipt.request.reference, command.reference)
          || current.receipt.claim.requestDigest !== command.expectedRequestDigest) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
        const control = invocationControl(this.db, current);
        const byCommand = this.db.prepare(`SELECT invocation_id FROM model_invocation_cancellations WHERE scope_id=? AND command_id=?`)
          .get(command.scopeId, command.commandId);
        if (byCommand && byCommand.invocation_id !== current.receipt.claim.invocationId) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
        if (control.cancellation) {
          if (!same(control.cancellation.command, command) || !same(control.cancellation.actor, actor)) {
            throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
          }
          return Object.freeze({ replayed: true, receipt: control.cancellation });
        }
        const state = current.receipt.outcome?.state;
        const disposition = control.send.state === 'pending' ? 'prevented'
          : state === 'responded' || state === 'rejected' ? 'already-terminal' : 'requested';
        const receipt = parseModelInvocationCancellationReceipt({ schemaVersion: 1, ...admission, claim: current.receipt.claim, disposition });
        const next = parseModelInvocationControlRecord({ ...control, cancellation: receipt,
          send: disposition === 'prevented' ? { state: 'prevented' } : control.send });
        const allocation = this.allocation(command.scopeId, current.receipt.profile.allocation.id);
        this.db.prepare(`INSERT INTO model_invocation_cancellations(scope_id,command_id,invocation_id,record) VALUES(?,?,?,?)`)
          .run(command.scopeId, command.commandId, current.receipt.claim.invocationId, encoded(receipt));
        writeInvocationControl(this.db, control, next);
        if (disposition === 'prevented') this.persistOutcome(current, createModelInvocationPreventedRecord(current.receipt, receipt), allocation);
        return Object.freeze({ replayed: false, receipt });
      });
    } catch (error) { return this.fail(error); }
  }
  async recordResponse(claim: ModelInvocationClaim, response: ModelInvocationNativeResponse, observedAtMs: number) {
    try { return this.settle(claim, record => createModelInvocationResponseRecord({ ...record.receipt, outcome: null }, response, observedAtMs)); }
    catch (error) { return this.fail(error); }
  }
  async recordRejected(claim: ModelInvocationClaim, evidence: ModelInvocationResponseEvidence, observedAtMs: number) {
    try {
      if (!evidence.body.complete) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      return this.settle(claim, record => createModelInvocationEvidenceRecord({ ...record.receipt, outcome: null }, evidence, observedAtMs));
    } catch (error) { return this.fail(error); }
  }
  async recordUnknown(claim: ModelInvocationClaim, reason: ModelInvocationUnknownReason, observedAtMs: number,
    evidence: ModelInvocationResponseEvidence | null = null) {
    try {
      if (reason !== 'transport-error' || evidence?.body.complete) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      return this.settle(claim, record => evidence === null
        ? createModelInvocationUnknownRecord({ ...record.receipt, outcome: null }, observedAtMs)
        : createModelInvocationEvidenceRecord({ ...record.receipt, outcome: null }, evidence, observedAtMs));
    } catch (error) { return this.fail(error); }
  }
  async purgeContent(input: ModelInvocationPurgeAdmission) {
    try { const admission = parseModelInvocationPurgeAdmission(input);
      return this.transaction(() => purgeInvocationContent(this.db, admission)); }
    catch (error) { return this.fail(error); }
  }
  close(): void { this.db.close(); }
}
