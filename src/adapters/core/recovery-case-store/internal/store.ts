import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { RecoveryError, assessRecoveryEffectGate, attemptIdentitySchema, closeRecoveryCase, continueLostTask, effectRecordSchema, identitySchema, recoveryCaseSchema,
  runSnapshotSchema, type AttemptIdentity, type EffectRecord, type RecoveryCase, type RunSnapshot } from '#domain/index.js';
import type { RecoveryAudit, RecoveryContinuationWrite, RecoveryStore, RecoveryTermination } from '#engine/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { ledgerTransaction, openSqliteLedger, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';

const corrupt = () => new RecoveryError('RECOVERY_CORRUPT');
const parse = <T>(work: () => T): T => { try { return work(); } catch { throw corrupt(); } };
/**
 * S6R-4 Core SQLite adapter of the recovery-case port on the shared ledger (v66). A case row is cross-checked against its columns on read; it moves
 * forward only by compare-and-swap on its exact stored record (the v66 trigger also refuses a skipped revision, a changed identity or a rewrite of a
 * closed case). The continuation is one writer transaction over the Run, the case, the gate set and the audit event.
 */
export class SqliteRecoveryStore implements RecoveryStore {
  constructor(private readonly db: DatabaseSync) {}
  close() { this.db.close(); }
  private readCase(scopeId: string, caseId: string): RecoveryCase | null {
    const row = this.db.prepare('SELECT run_id,task_id,attempt_id,state,revision,record FROM recovery_cases WHERE scope_id=? AND case_id=?').get(scopeId, caseId);
    if (!row) return null;
    const value = parse(() => recoveryCaseSchema.parse(JSON.parse(String(row['record']))));
    if (value.caseId !== caseId || value.identity.scopeId !== scopeId || value.identity.runId !== row['run_id'] || value.identity.taskId !== row['task_id']
      || value.identity.attemptId !== row['attempt_id'] || value.state !== row['state'] || value.revision !== row['revision']) throw corrupt();
    return value;
  }
  private readRun(scopeId: string, runId: string): RunSnapshot | null {
    const row = this.db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
    if (!row) return null;
    const run = parse(() => runSnapshotSchema.parse(JSON.parse(String(row['snapshot']))));
    if (run.identity.scopeId !== scopeId || run.identity.runId !== runId || run.revision !== row['revision']) throw corrupt();
    return run;
  }
  private readGateEffects(identity: AttemptIdentity, limit: number): EffectRecord[] {
    // The v63 producer index serves the Attempt's own intents; older rows (no producer) join only while open (fail-closed window rule).
    return this.db.prepare(`SELECT command_id,state,record FROM effect_intents WHERE scope_id=? AND (json_extract(record,'$.intent.producer.identity.attemptId')=?
      OR (json_extract(record,'$.intent.producer') IS NULL AND state IN('claimed','unknown'))) ORDER BY rowid LIMIT ?`).all(identity.scopeId, identity.attemptId, limit).map(row => {
      const record = parse(() => effectRecordSchema.parse(JSON.parse(String(row['record']))));
      if (record.intent.command.commandId !== row['command_id'] || record.state !== row['state'] || record.intent.command.scopeId !== identity.scopeId) throw corrupt();
      return record;
    });
  }
  private write(previous: RecoveryCase | null, next: RecoveryCase) {
    const { scopeId, runId, taskId, attemptId } = next.identity;
    if (!previous) {
      const stored = this.readCase(scopeId, next.caseId);
      if (stored) { if (!isDeepStrictEqual(stored, next)) throw new RecoveryError('RECOVERY_CONFLICT'); return stored; }
      this.db.prepare('INSERT INTO recovery_cases(scope_id,case_id,run_id,task_id,attempt_id,state,revision,record) VALUES(?,?,?,?,?,?,?,?)')
        .run(scopeId, next.caseId, runId, taskId, attemptId, next.state, next.revision, JSON.stringify(next));
      return next;
    }
    if (previous.caseId !== next.caseId || !isDeepStrictEqual(previous.identity, next.identity) || next.revision !== previous.revision + 1) throw new RecoveryError('RECOVERY_CONFLICT');
    const changed = this.db.prepare('UPDATE recovery_cases SET state=?,revision=?,record=? WHERE scope_id=? AND case_id=? AND revision=? AND record=?')
      .run(next.state, next.revision, JSON.stringify(next), scopeId, next.caseId, previous.revision, JSON.stringify(previous));
    if (changed.changes !== 1) throw new RecoveryError('RECOVERY_CONFLICT');
    return next;
  }
  private transaction<T>(work: () => T): T { return ledgerTransaction(this.db, work); }
  async loadCase(scopeInput: string, caseId: string) { return this.readCase(identitySchema.parse(scopeInput), caseId); }
  async loadRun(scopeInput: string, runInput: string) { return this.readRun(identitySchema.parse(scopeInput), identitySchema.parse(runInput)); }
  async loadTermination(scopeInput: string, receiptId: string): Promise<RecoveryTermination | null> {
    const row = this.db.prepare('SELECT command FROM run_receipts WHERE scope_id=? AND command_id=?').get(identitySchema.parse(scopeInput), identitySchema.parse(receiptId));
    if (!row) return null;
    const payload = parse(() => JSON.parse(String(row['command'])) as { operation?: unknown; proof?: { kind?: unknown; receiptId?: unknown; result?: { exitCode?: unknown } } });
    const kind = payload.proof?.kind, exitCode = payload.proof?.result?.exitCode;
    if (payload.operation !== 'release-worker-custody' || payload.proof?.receiptId !== receiptId || (kind !== 'worker-absent' && kind !== 'supervisor-exit' && kind !== 'created-container-absent')) throw corrupt();
    return Object.freeze({ receiptId, kind, exitCode: typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? exitCode : null });
  }
  async listGateEffects(input: AttemptIdentity, limit: number) { return this.readGateEffects(attemptIdentitySchema.parse(input), limit); }
  async saveCase(previous: RecoveryCase | null, input: RecoveryCase) {
    const next = recoveryCaseSchema.parse(input);
    return this.transaction(() => this.write(previous, next));
  }
  async continueLostTask(write: RecoveryContinuationWrite, audit: RecoveryAudit) {
    const previous = recoveryCaseSchema.parse(write.previous), { identity } = previous;
    return this.transaction(() => {
      const current = this.readCase(identity.scopeId, previous.caseId);
      if (!current || !isDeepStrictEqual(current, previous) || current.state !== 'gated') throw new RecoveryError('RECOVERY_CONFLICT');
      const run = this.readRun(identity.scopeId, identity.runId);
      if (!run?.execution.recovery) throw new RecoveryError('RECOVERY_OFF');
      // The store re-check: the gate set and the task's earlier continued signatures are read again inside this transaction.
      const gate = assessRecoveryEffectGate(identity, this.readGateEffects(identity, run.execution.recovery.maxGateIntents + 1), run.execution.recovery);
      const priorSignatures = this.db.prepare("SELECT record FROM recovery_cases WHERE scope_id=? AND run_id=? AND task_id=? AND state='applied'")
        .all(identity.scopeId, identity.runId, identity.taskId).map(row => { const value = parse(() => recoveryCaseSchema.parse(JSON.parse(String(row['record']))));
          return value.decision?.action === 'continue-new-attempt' ? value.decision.signature : null; }).filter((value): value is string => value !== null);
      const { snapshot } = continueLostTask(run, run.revision, identity, { decisionId: write.decision.decisionId, signature: write.decision.signature, gate, priorSignatures },
        { now: write.now, timeoutMs: write.timeoutMs });
      const updated = this.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
        .run(snapshot.revision, JSON.stringify(snapshot), identity.scopeId, identity.runId, run.revision);
      if (updated.changes !== 1) throw new RecoveryError('RECOVERY_CONFLICT');
      const closed = this.write(current, recoveryCaseSchema.parse({ ...closeRecoveryCase(current, write.decision, write.now), gate }));
      const sealed = audit(new SqliteAuditStore(this.db), snapshot, closed);
      if (this.db.prepare('SELECT record FROM audit_events WHERE scope_id=? AND event_id=?').get(identity.scopeId, sealed.event.eventId)?.['record'] !== JSON.stringify(sealed)) throw corrupt();
      return Object.freeze({ case: closed, run: snapshot });
    });
  }
}
/** The writer opens the ledger without migrating (`forbid`): an older or newer ledger is refused (`ATTEMPT_STORE_VERSION`). */
export function openSqliteRecoveryStore(path: string, options: SqliteLedgerOptions): SqliteRecoveryStore { return new SqliteRecoveryStore(openSqliteLedger(path, options, 'forbid')); }
