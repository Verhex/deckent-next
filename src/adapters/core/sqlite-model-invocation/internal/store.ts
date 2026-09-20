import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { identitySchema, modelInvocationClaimSchema,
  type ModelInvocationClaim, type ModelInvocationNativeResponse,
  type ModelInvocationReceipt, type ModelInvocationResponseEvidence, type ModelInvocationUnknownReason } from '#domain/index.js';
import { ModelInvocationStoreError, parseModelInvocationAdmission, sameModelInvocationRequest,
  verifyModelInvocationReceipt, createModelInvocationClaimReceipt, type ModelInvocationAdmission, type ModelInvocationClaimResult,
  type ModelInvocationStore, verifyModelActivationRecord } from '#engine/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';
import { decodeInvocationReceipt, invocationCommandRow, invocationIdentity, invocationRow, loadInvocationReceipt } from './read.js';

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
  async loadReceipt(scopeInput: string, commandInput: string): Promise<ModelInvocationReceipt | null> {
    try { const scopeId = invocationIdentity(scopeInput), commandId = invocationIdentity(commandInput);
      return decodeInvocationReceipt(invocationCommandRow(this.db, scopeId, commandId), scopeId, commandId, 'command_id'); }
    catch (error) { return this.fail(error); }
  }
  async loadInvocation(scopeInput: string, invocationInput: string): Promise<ModelInvocationReceipt | null> {
    try { return loadInvocationReceipt(this.db, scopeInput, invocationInput); }
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
        sum(CASE WHEN state IN ('responded','rejected') THEN 0 ELSE 1 END) AS in_flight
        FROM model_invocations WHERE scope_id=? AND allocation_id=?`).get(scopeId, allocationId);
      if (observed?.lifetime_calls !== record.lifetimeCalls || (observed?.in_flight ?? 0) !== record.inFlight) throw new Error();
      return record;
    } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
  }
  async claim(input: ModelInvocationAdmission): Promise<ModelInvocationClaimResult> {
    try {
      const admission = parseModelInvocationAdmission(input), { command, profile } = admission;
      return this.transaction(() => {
        const prior = decodeInvocationReceipt(invocationCommandRow(this.db, command.scopeId, command.commandId), command.scopeId, command.commandId, 'command_id');
        if (prior) {
          if (!sameModelInvocationRequest(prior, command, admission.requestDigest, admission.actor)) {
            throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
          }
          return Object.freeze({ replayed: true, receipt: prior });
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
        return Object.freeze({ replayed: false, receipt });
      });
    } catch (error) { return this.fail(error); }
  }
  private settle(claimInput: ModelInvocationClaim, outcome: NonNullable<ModelInvocationReceipt['outcome']>): ModelInvocationReceipt {
    const parsed = modelInvocationClaimSchema.parse(claimInput);
    return this.transaction(() => {
      const current = decodeInvocationReceipt(invocationRow(this.db, parsed.scopeId, parsed.invocationId), parsed.scopeId, parsed.invocationId, 'invocation_id');
      if (!current) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
      if (!same(current.claim, parsed)) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
      const allocation = this.allocation(current.request.scopeId, current.profile.allocation.id);
      if (current.outcome) {
        if (!same(current.outcome, outcome)) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
        return current;
      }
      const receipt = verifyModelInvocationReceipt({ ...current, outcome });
      if (!allocation || allocation.inFlight < 1) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      if (outcome.state === 'responded' || outcome.state === 'rejected') {
        const after = allocationSchema.parse({ ...allocation, inFlight: allocation.inFlight - 1 });
        const updated = this.db.prepare(`UPDATE model_invocation_allocations SET in_flight=?,record=?
          WHERE scope_id=? AND allocation_id=? AND lifetime_calls=? AND in_flight=?`)
          .run(after.inFlight, encoded(after), allocation.scopeId, allocation.allocationId, allocation.lifetimeCalls, allocation.inFlight);
        if (updated.changes !== 1) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      }
      const record = encoded(receipt);
      const invocation = this.db.prepare('UPDATE model_invocations SET state=?,record=? WHERE scope_id=? AND invocation_id=?')
        .run(outcome.state, record, parsed.scopeId, parsed.invocationId);
      if (invocation.changes !== 1) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      return receipt;
    });
  }
  async recordResponse(claim: ModelInvocationClaim, response: ModelInvocationNativeResponse, observedAtMs: number) {
    try { return this.settle(claim, { schemaVersion: 2, state: 'responded', response, observedAtMs }); }
    catch (error) { return this.fail(error); }
  }
  async recordRejected(claim: ModelInvocationClaim, evidence: ModelInvocationResponseEvidence, observedAtMs: number) {
    try { return this.settle(claim, { schemaVersion: 2, state: 'rejected', evidence, observedAtMs }); }
    catch (error) { return this.fail(error); }
  }
  async recordUnknown(claim: ModelInvocationClaim, reason: ModelInvocationUnknownReason, observedAtMs: number,
    evidence: ModelInvocationResponseEvidence | null = null) {
    try { return this.settle(claim, { schemaVersion: 2, state: 'unknown', reason, evidence, observedAtMs }); }
    catch (error) { return this.fail(error); }
  }
  close(): void { this.db.close(); }
}
