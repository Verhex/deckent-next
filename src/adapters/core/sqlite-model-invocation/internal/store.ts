import { readModelAllocationCheckpoint, writeModelAllocation } from './allocation.js';
import { invocationControl, writeInvocationControl } from './control.js';
import { reserveInvocationSpend, settleInvocationSpend, verifyInvocationSpendReplay,
  verifyInvocationSpendSettlementReplay } from './spend.js';
import { purgeInvocationContent } from './purge.js';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { counterSchema, modelInvocationClaimSchema, parseModelInvocationControlRecord, parseModelInvocationCancellationReceipt, proposeModelInvocationSendPermission,
  type ModelInvocationClaim, type ModelInvocationNativeResponse,
  type ModelInvocationResponseEvidence, type ModelInvocationUnknownReason } from '#domain/index.js';
import { parseModelAllocation, type ModelAllocationCheckpoint, ProviderSpendError, parseModelInvocationCancellationAdmission, createModelInvocationPreventedRecord, type ModelInvocationCancellationAdmission, ModelInvocationStoreError, parseModelInvocationAdmission, sameModelInvocationRequest,
  verifyModelInvocationRecord, createModelInvocationClaimReceipt,
  createModelInvocationResponseRecord, createModelInvocationEvidenceRecord, createModelInvocationUnknownRecord, type ModelInvocationRecord, parseModelInvocationPurgeAdmission, type ModelInvocationPurgeAdmission, type ModelInvocationAdmission, type ModelInvocationClaimResult,
  type ModelInvocationStore, type ProviderSpendMeasurement, verifyModelActivationRecord,
  planModelAllocationSlotRelease, type ModelAllocationSlotRelease, type ModelAllocationSlotReleaseStore, type ModelAllocationStartCustody } from '#engine/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';
import { decodeInvocationRecord, invocationCommandRow, invocationIdentity, invocationRow, loadInvocationRecord, visitAllocationInvocations } from './read.js';

type Row = Readonly<Record<string, unknown>>;
const encoded = (value: unknown) => JSON.stringify(value);
const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right);

export class SqliteModelInvocationStore implements ModelInvocationStore, ModelAllocationSlotReleaseStore {
  constructor(private readonly db: DatabaseSync) {}

  private fail(error: unknown): never {
    if (error instanceof ModelInvocationStoreError || error instanceof ProviderSpendError) throw error;
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
  async claim(input: ModelInvocationAdmission): Promise<ModelInvocationClaimResult> {
    try {
      const admission = parseModelInvocationAdmission(input), { command, profile } = admission;
      return this.transaction(() => {
        const prior = decodeInvocationRecord(invocationCommandRow(this.db, command.scopeId, command.commandId), command.scopeId, command.commandId, 'command_id');
        if (prior) {
          if (!sameModelInvocationRequest(prior.receipt, command, admission.requestDigest, admission.actor)) {
            throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
          }
          verifyInvocationSpendReplay(this.db, admission, prior);
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
        const configured = profile.allocation, checkpoint = readModelAllocationCheckpoint(this.db, command.scopeId, configured.id);
        const current = checkpoint?.allocation;
        if (current && (current.maxCalls !== configured.maxCalls || current.maxInFlight !== configured.maxInFlight)) {
          throw new ModelInvocationStoreError('MODEL_INVOCATION_ALLOCATION_CONFLICT');
        }
        const before = current ?? parseModelAllocation({ schemaVersion: 1, scopeId: command.scopeId, allocationId: configured.id,
          maxCalls: configured.maxCalls, maxInFlight: configured.maxInFlight, lifetimeCalls: 0, inFlight: 0 });
        if (before.maxCalls !== null && before.lifetimeCalls >= before.maxCalls) throw new ModelInvocationStoreError('MODEL_INVOCATION_QUOTA_EXHAUSTED');
        if (before.inFlight >= before.maxInFlight) throw new ModelInvocationStoreError('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
        const after = parseModelAllocation({ ...before, lifetimeCalls: before.lifetimeCalls + 1, inFlight: before.inFlight + 1 });
        writeModelAllocation(this.db, checkpoint, after);
        const receipt = createModelInvocationClaimReceipt(admission);
        const record = encoded(receipt);
        this.db.prepare('INSERT INTO model_invocations(scope_id,command_id,invocation_id,allocation_id,state,record) VALUES(?,?,?,?,?,?)')
          .run(command.scopeId, command.commandId, admission.invocationId, profile.allocation.id, 'claimed', record);
        const control = parseModelInvocationControlRecord({ schemaVersion: 1, claim: receipt.claim, reference: receipt.request.reference,
          send: { state: 'pending' }, cancellation: null });
        this.db.prepare(`INSERT INTO model_invocation_controls(scope_id,invocation_id,send_state,record) VALUES(?,?,?,?)`)
          .run(command.scopeId, admission.invocationId, 'pending', encoded(control));
        reserveInvocationSpend(this.db, admission);
        return Object.freeze({ replayed: false, record: verifyModelInvocationRecord({ receipt, content: null, purge: null }) });
      });
    } catch (error) { return this.fail(error); }
  }
  private settle(claimInput: ModelInvocationClaim, build: (record: ModelInvocationRecord) => ModelInvocationRecord,
    measurement: ProviderSpendMeasurement | null | undefined = null): ModelInvocationRecord {
    const parsed = modelInvocationClaimSchema.parse(claimInput);
    return this.transaction(() => {
      const current = decodeInvocationRecord(invocationRow(this.db, parsed.scopeId, parsed.invocationId), parsed.scopeId, parsed.invocationId, 'invocation_id');
      if (!current || !same(current.receipt.claim, parsed)) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
      const allocation = readModelAllocationCheckpoint(this.db, current.receipt.request.scopeId, current.receipt.profile.allocation.id);
      const next = verifyModelInvocationRecord(build(current));
      if (current.receipt.outcome) {
        if (!same(current, next)) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
        verifyInvocationSpendSettlementReplay(this.db, current, measurement);
        return current;
      }
      const control = invocationControl(this.db, current);
      if (control.send.state !== 'permitted' && control.send.state !== 'unobserved') {
        throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
      }
      this.persistOutcome(current, next, allocation, measurement);
      return next;
    });
  }
  private persistOutcome(current: ModelInvocationRecord, next: ModelInvocationRecord, checkpoint: ModelAllocationCheckpoint | null,
    measurement: ProviderSpendMeasurement | null | undefined = null): void {
    if (!next.receipt.outcome || !same({ ...next.receipt, outcome: null }, current.receipt)) {
      throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    }
    const allocation = checkpoint?.allocation;
    if (!allocation || !checkpoint || allocation.inFlight < 1) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    const outcome = next.receipt.outcome;
    settleInvocationSpend(this.db, next, measurement);
    // Every outcome, `unknown` included, is recorded after the local send settled with its request closed: the slot is free again.
    // The uncertain record, its spending hold and the lifetime count stay (INFLIGHT-FIX, replacing PROVIDERS/A3A).
    writeModelAllocation(this.db, checkpoint, parseModelAllocation({ ...allocation, inFlight: allocation.inFlight - 1 }));
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
        if (!readModelAllocationCheckpoint(this.db, claim.scopeId, record.receipt.profile.allocation.id)) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
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
        const allocation = readModelAllocationCheckpoint(this.db, command.scopeId, current.receipt.profile.allocation.id);
        this.db.prepare(`INSERT INTO model_invocation_cancellations(scope_id,command_id,invocation_id,record) VALUES(?,?,?,?)`)
          .run(command.scopeId, command.commandId, current.receipt.claim.invocationId, encoded(receipt));
        writeInvocationControl(this.db, control, next);
        if (disposition === 'prevented') this.persistOutcome(current, createModelInvocationPreventedRecord(current.receipt, receipt), allocation);
        return Object.freeze({ replayed: false, receipt });
      });
    } catch (error) { return this.fail(error); }
  }
  async recordResponse(claim: ModelInvocationClaim, response: ModelInvocationNativeResponse, observedAtMs: number,
    measurement?: ProviderSpendMeasurement | null) {
    try { return this.settle(claim,
      record => createModelInvocationResponseRecord({ ...record.receipt, outcome: null }, response, observedAtMs), measurement); }
    catch (error) { return this.fail(error); }
  }
  async recordRejected(claim: ModelInvocationClaim, evidence: ModelInvocationResponseEvidence, observedAtMs: number) {
    try {
      if (!evidence.body.complete) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      return this.settle(claim, record => createModelInvocationEvidenceRecord({ ...record.receipt, outcome: null }, evidence, observedAtMs));
    } catch (error) { return this.fail(error); }
  }
  async recordUnknown(claim: ModelInvocationClaim, reason: ModelInvocationUnknownReason, observedAtMs: number,
    evidence: ModelInvocationResponseEvidence | null = null, measurement: ProviderSpendMeasurement | null = null) {
    try {
      if (reason !== 'transport-error' || evidence?.body.complete) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      return this.settle(claim, record => evidence === null
        ? createModelInvocationUnknownRecord({ ...record.receipt, outcome: null }, observedAtMs)
        : createModelInvocationEvidenceRecord({ ...record.receipt, outcome: null }, evidence, observedAtMs), measurement);
    } catch (error) { return this.fail(error); }
  }
  /** Start reconciliation (INFLIGHT-FIX, Astra 2143 R1, FIX-2143-SLOTS): one transaction per allocation, through the same checkpointed
   * writer as claims; every decision rests on records the decoder verified in that transaction, never on a bare column. */
  async releaseSettledSlots(custody: ModelAllocationStartCustody): Promise<ModelAllocationSlotRelease> {
    try {
      const atMs = counterSchema.parse(custody.atMs), endedOwner = custody.endedOwner;
      if (typeof endedOwner !== 'function') throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      const keys = this.db.prepare('SELECT scope_id,allocation_id FROM model_invocation_allocations ORDER BY scope_id,allocation_id').all() as Row[];
      let released = 0, settled = 0; const inconsistent: { scopeId: string; allocationId: string }[] = [];
      for (const key of keys) {
        const scopeId = String(key['scope_id']), allocationId = String(key['allocation_id']);
        try {
          const result = this.transaction(() => this.reconcileAllocation(scopeId, allocationId, endedOwner, atMs));
          released += result.released; settled += result.settled;
        } catch (error) {
          // A damaged or unexplained allocation is rolled back, reported and left as it is; it never blocks the others or the service start.
          if (!(error instanceof ProviderSpendError) && (!(error instanceof ModelInvocationStoreError) || error.code !== 'MODEL_INVOCATION_CORRUPT')) throw error;
          inconsistent.push(Object.freeze({ scopeId, allocationId }));
        }
      }
      return Object.freeze({ allocations: keys.length, released, settled, inconsistent: Object.freeze(inconsistent) });
    } catch (error) { return this.fail(error); }
  }
  private reconcileAllocation(scopeId: string, allocationId: string, endedOwner: (ownerId: string) => boolean, atMs: number) {
    const corrupt = () => new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    const checkpoint = readModelAllocationCheckpoint(this.db, scopeId, allocationId);
    if (!checkpoint) throw corrupt();
    const allocation = checkpoint.allocation;
    // A clean restart: no slot held and no open row, so nothing can be written and nothing needs decoding.
    const openRows = Number(this.db.prepare("SELECT count(*) AS count FROM model_invocations WHERE scope_id=? AND allocation_id=? AND state='claimed'")
      .get(scopeId, allocationId)?.['count']);
    if (allocation.inFlight === 0 && openRows === 0) return { released: 0, settled: 0 };
    let retained = 0, unknown = 0; const open: ModelInvocationRecord[] = [];
    visitAllocationInvocations(this.db, scopeId, allocationId, record => {
      const limits = record.receipt.profile.allocation;
      if (limits.maxCalls !== allocation.maxCalls || limits.maxInFlight !== allocation.maxInFlight) throw corrupt();
      retained++;
      if (record.receipt.outcome === null) { if (open.push(record) > allocation.inFlight) throw corrupt(); }
      else if (record.receipt.outcome.state === 'unknown') unknown++;
    });
    // Every claim is retained and counted once: a missing or moved row means the counts below prove nothing.
    if (retained !== allocation.lifetimeCalls || planModelAllocationSlotRelease(allocation, { open: open.length, unknown }).kind === 'inconsistent') throw corrupt();
    // An open call whose permitted send owner custody proves ended: its process, and with it the local request, is gone. It settles
    // `unknown` through the ordinary settlement (spending hold, lifetime count and uncertain record kept) and frees its slot.
    let settled = 0;
    for (const record of open) {
      const control = invocationControl(this.db, record);
      if (control.send.state !== 'permitted' || !endedOwner(control.send.ownerId)) continue;
      this.persistOutcome(record, createModelInvocationUnknownRecord(record.receipt, atMs), readModelAllocationCheckpoint(this.db, scopeId, allocationId));
      settled++;
    }
    // An earlier build's surplus is planned from the counts after those settlements, so no slot is freed twice.
    const current = readModelAllocationCheckpoint(this.db, scopeId, allocationId);
    if (!current) throw corrupt();
    const plan = planModelAllocationSlotRelease(current.allocation, { open: open.length - settled, unknown: unknown + settled });
    if (plan.kind === 'inconsistent') throw corrupt();
    if (plan.kind === 'release') writeModelAllocation(this.db, current, plan.next);
    return { released: plan.kind === 'release' ? plan.released : 0, settled };
  }
  async purgeContent(input: ModelInvocationPurgeAdmission) {
    try { const admission = parseModelInvocationPurgeAdmission(input);
      return this.transaction(() => purgeInvocationContent(this.db, admission)); }
    catch (error) { return this.fail(error); }
  }
  close(): void { this.db.close(); }
}
