import { artifactReceiptSchema, type ArtifactReceipt } from '#capabilities/index.js';
import type { DatabaseSync } from 'node:sqlite';
import { attemptSnapshotSchema, sameAttemptIdentity } from '#domain/index.js';
import { dispatchClaimSchema, dispatchTerminalSchema, dispatchRecordSchema, DispatchError, AttemptStoreError,
  projectDispatchTerminal, mergeDispatchTerminal, sandboxRequestSchema, sameSandboxRequest, type DispatchClaim, type DispatchTerminal, type DispatchRecord } from '#engine/index.js';
import { sqliteFailure } from './options.js';

export class SqliteDispatchJournal {
  constructor(private readonly db: DatabaseSync) {}
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
  async claimDispatch(input: DispatchClaim) {
    const claim = dispatchClaimSchema.parse(input);
    return this.transaction(() => {
      const existing = this.read(claim.request);
      if (existing) return Object.freeze({ acquired: false, record: existing });
      const identity = claim.request.identity;
      const row = this.db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
      if (!row) throw new DispatchError('DISPATCH_NOT_ADMITTED');
      let attempt;
      try { attempt = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
      if (!sameAttemptIdentity(identity, attempt.identity) || attempt.cancelRequested || attempt.lastObservation !== null) throw new DispatchError('DISPATCH_NOT_ADMITTED');
      const record = dispatchRecordSchema.parse({ schemaVersion: 1, ...claim, terminal: null });
      this.db.prepare('INSERT INTO dispatches(scope_id,attempt_id,record) VALUES(?,?,?)').run(identity.scopeId, identity.attemptId, JSON.stringify(record));
      return Object.freeze({ acquired: true, record });
    });
  }
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
      const record = dispatchRecordSchema.parse({ ...existing, terminal });
      this.db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?').run(JSON.stringify(record), claim.request.identity.scopeId, claim.request.identity.attemptId);
      return record;
    });
  }
}
