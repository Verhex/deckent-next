import { grantDispatchLaunch } from './launch.js';
import { SqliteRunDispatch } from './run-dispatch.js';
import { artifactReceiptSchema, type ArtifactReceipt } from '#capabilities/index.js';
import type { DatabaseSync } from 'node:sqlite';
import { verifiedPrincipalSchema, type VerifiedPrincipal, attemptSnapshotSchema, sameAttemptIdentity } from '#domain/index.js';
import { dispatchInventoryQuerySchema, type DispatchInventoryQuery, dispatchClaimSchema, dispatchAdmissionSchema, dispatchTerminalSchema, dispatchRecordSchema, DispatchError, AttemptStoreError,
  projectDispatchTerminal, projectDispatchCancellation, mergeDispatchTerminal, sandboxRequestSchema, sameSandboxRequest, type DispatchClaim, type DispatchAdmission, type SupervisorProfileValidator, type LaunchRequest, type DispatchTerminal, type DispatchRecord } from '#engine/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';

export class SqliteDispatchJournal {
  constructor(private readonly db: DatabaseSync, private readonly profiles?: SupervisorProfileValidator) {}
  private read(request: DispatchClaim['request']): DispatchRecord | null {
    const identity = request.identity;
    const row = this.db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
    if (!row) return null;
    let record;
    try { record = dispatchRecordSchema.parse(JSON.parse(String(row.record))); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
    if (!sameSandboxRequest(record.request, request)) throw new DispatchError('DISPATCH_CONFLICT');
    return record;
  }
  private transaction<T>(work: () => T): T {
    let active = false;
    try { this.db.exec('BEGIN IMMEDIATE'); active = true; const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) {
      if (active) { try { this.db.exec('ROLLBACK'); } catch { throw new AttemptStoreError('ATTEMPT_STORE_OUTCOME_UNKNOWN'); } }
      throw sqliteFailure(error);
    }
  }
  async listDispatches(input: DispatchInventoryQuery) {
    const query = dispatchInventoryQuerySchema.parse(input);
    try {
      const rows = this.db.prepare('SELECT d.attempt_id,d.record,a.snapshot FROM dispatches d LEFT JOIN attempts a ON a.scope_id=d.scope_id AND a.attempt_id=d.attempt_id WHERE d.scope_id=? AND (? IS NULL OR d.attempt_id>?) ORDER BY d.attempt_id LIMIT ?')
        .all(query.scopeId, query.after, query.after, query.limit + 1);
      const entries = rows.slice(0, query.limit).map(row => {
        let record; let attempt;
        try { record = dispatchRecordSchema.parse(JSON.parse(String(row.record))); attempt = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
        if (record.request.identity.scopeId !== query.scopeId || record.request.identity.attemptId !== row.attempt_id || !sameAttemptIdentity(record.request.identity, attempt.identity)) throw new DispatchError('DISPATCH_CORRUPT');
        return Object.freeze({ identity: record.request.identity, owner: record.owner, launch: record.launch, terminal: record.terminal,
          cancellationRequested: attempt.cancelRequested, outputRecorded: !!record.output });
      });
      return Object.freeze({ entries: Object.freeze(entries), nextAfter: rows.length > query.limit ? entries.at(-1)!.identity.attemptId : null });
    } catch (error) { throw sqliteFailure(error); }
  }
  async requestDispatchCancellation(input: DispatchClaim['request'], actor: VerifiedPrincipal) {
    const request = sandboxRequestSchema.parse(input); const principal = verifiedPrincipalSchema.parse(actor);
    if (!principal.scopeIds.includes(request.identity.scopeId)) throw new DispatchError('DISPATCH_NOT_ADMITTED');
    return this.transaction(() => {
      const existing = this.read(request);
      if (!existing) throw new DispatchError('DISPATCH_NOT_ADMITTED');
      if (existing.terminal || existing.cancellation) return existing;
      const identity = request.identity;
      const row = this.db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
      if (!row) throw new DispatchError('DISPATCH_CORRUPT');
      let current;
      try { current = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
      const next = projectDispatchCancellation(current, { request, owner: existing.owner });
      const record = dispatchRecordSchema.parse({ ...existing, cancellation: { id: principal.id, issuer: principal.issuer, subject: principal.subject } });
      const updated = this.db.prepare('UPDATE attempts SET revision=?,snapshot=? WHERE scope_id=? AND attempt_id=? AND revision=?')
        .run(next.revision, JSON.stringify(next), identity.scopeId, identity.attemptId, current.revision);
      if (updated.changes !== 1) throw new DispatchError('DISPATCH_CONFLICT');
      this.db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?').run(JSON.stringify(record), identity.scopeId, identity.attemptId);
      return record;
    });
  }
  async retainDispatchOutput(input: DispatchClaim, value: ArtifactReceipt) {
    const claim = dispatchClaimSchema.parse(input); const receipt = artifactReceiptSchema.parse(value);
    if (receipt.scopeId !== claim.request.identity.scopeId) throw new DispatchError('DISPATCH_CONFLICT');
    return this.transaction(() => {
      const existing = this.read(claim.request);
      if (!existing || existing.owner !== claim.owner) throw new DispatchError('DISPATCH_CONFLICT');
      if (existing.output) {
        if (existing.output.digest !== receipt.digest || existing.output.byteLength !== receipt.byteLength || existing.output.scopeId !== receipt.scopeId) throw new DispatchError('DISPATCH_CONFLICT');
        return existing;
      }
      const record = dispatchRecordSchema.parse({ ...existing, output: receipt });
      this.db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?')
        .run(JSON.stringify(record), claim.request.identity.scopeId, claim.request.identity.attemptId);
      return record;
    });
  }
  async readDispatch(request: DispatchClaim['request']) {
    const parsed = sandboxRequestSchema.parse(request);
    try { return this.read(parsed); } catch (error) { throw sqliteFailure(error); }
  }
  async claimDispatch(input: DispatchAdmission) {
    const claim = dispatchAdmissionSchema.parse(input);
    if (!this.profiles) throw new DispatchError('DISPATCH_PROFILE_VALIDATION_REQUIRED');
    if (this.profiles.validate(claim.profile) !== undefined) throw new DispatchError('DISPATCH_PROFILE_VALIDATION_REQUIRED');
    return this.transaction(() => {
      const existing = this.read(claim.request);
      if (existing) return Object.freeze({ acquired: false, record: existing });
      const identity = claim.request.identity;
      const row = this.db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
      if (!row) throw new DispatchError('DISPATCH_NOT_ADMITTED');
      let attempt;
      try { attempt = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
      if (!sameAttemptIdentity(identity, attempt.identity) || attempt.cancelRequested || attempt.lastObservation !== null) throw new DispatchError('DISPATCH_NOT_ADMITTED');
      new SqliteRunDispatch(this.db).admit(identity);
      const record = dispatchRecordSchema.parse({ schemaVersion: 2, ...claim, launch: 'pending', terminal: null });
      this.db.prepare('INSERT INTO dispatches(scope_id,attempt_id,record) VALUES(?,?,?)').run(identity.scopeId, identity.attemptId, JSON.stringify(record));
      return Object.freeze({ acquired: true, record });
    });
  }
  async grantLaunch(input: LaunchRequest) { return this.transaction(() => grantDispatchLaunch(this.db, input)); }
  async finishDispatch(input: DispatchClaim, value: DispatchTerminal) {
    const claim = dispatchClaimSchema.parse(input); const terminal = dispatchTerminalSchema.parse(value);
    return this.transaction(() => {
      const existing = this.read(claim.request);
      if (!existing || existing.owner !== claim.owner) throw new DispatchError('DISPATCH_CONFLICT');
      if (existing.terminal) {
        const merged = mergeDispatchTerminal(existing.terminal, terminal);
        if (merged === existing.terminal) return existing;
        const enriched = dispatchRecordSchema.parse({ ...existing, terminal: merged });
        this.db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?')
          .run(JSON.stringify(enriched), claim.request.identity.scopeId, claim.request.identity.attemptId);
        return enriched;
      }
      const identity = claim.request.identity;
      const row = this.db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
      if (!row) throw new DispatchError('DISPATCH_CORRUPT');
      let current;
      try { current = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
      const projected = projectDispatchTerminal(current, claim, terminal);
      const written = this.db.prepare('UPDATE attempts SET revision=?,snapshot=? WHERE scope_id=? AND attempt_id=? AND revision=?')
        .run(projected.revision, JSON.stringify(projected), identity.scopeId, identity.attemptId, current.revision);
      if (written.changes !== 1) throw new DispatchError('DISPATCH_CONFLICT');
      new SqliteRunDispatch(this.db).project(projected);
      const record = dispatchRecordSchema.parse({ ...existing, terminal });
      this.db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?').run(JSON.stringify(record), claim.request.identity.scopeId, claim.request.identity.attemptId);
      return record;
    });
  }
}
