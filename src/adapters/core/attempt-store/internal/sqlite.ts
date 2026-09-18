import { readRunBoundDispatch } from './run-dispatch-lookup.js';
import { migrateLedger } from './schema.js';
import { loadCancellationDispatch } from './run-cancellation.js';
import type { AttemptIdentity } from '#domain/index.js';
import { SqliteRunJournal } from './runs.js';
import type { RunStore, RunCancellation, ExecutionPool, RunCreate, RunReservation, RunProjection } from '#engine/index.js';
import type { ArtifactReceipt } from '#capabilities/index.js';
import { SqliteDispatchJournal } from './dispatch.js';
import type { DispatchClaim, DispatchAdmission, SupervisorProfileValidator, LaunchRequest, DispatchTerminal, DispatchStore, RunBoundDispatchStore, DispatchInventoryQuery, DispatchInventoryStore } from '#engine/index.js';
import { sqliteAttemptOptionsSchema, sqliteFailure, type SqliteAttemptOptions } from './options.js';
import { DatabaseSync } from 'node:sqlite';
import { attemptSnapshotSchema, sameAttemptIdentity, verifiedPrincipalSchema, type VerifiedPrincipal } from '#domain/index.js';
import { AttemptStoreError, dispatchRecordSchema, type AttemptCommit, type AttemptReceipt, type AttemptStore } from '#engine/index.js';

/** Dedicated execution database. Path ownership/permissions are established by composition, not this adapter. */
export class SqliteAttemptStore implements AttemptStore, DispatchStore, RunBoundDispatchStore, DispatchInventoryStore, RunStore {
  private readonly db: DatabaseSync;
  constructor(path: string, options: SqliteAttemptOptions, migration: 'allow' | 'forbid' = 'allow', private readonly profiles?: SupervisorProfileValidator) {
    if (migration !== 'allow' && migration !== 'forbid') throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
    const parsed = sqliteAttemptOptionsSchema.safeParse(options);
    if (!parsed.success) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
    try { this.db = new DatabaseSync(path, { timeout: parsed.data.busyTimeoutMs }); }
    catch (error) { throw sqliteFailure(error); }
    try {
      this.db.exec('BEGIN IMMEDIATE');
      migrateLedger(this.db, migration, this.profiles);
      this.db.exec('COMMIT');
      const journal = { wal: 'PRAGMA journal_mode=WAL', delete: 'PRAGMA journal_mode=DELETE' };
      const durability = { full: 'PRAGMA synchronous=FULL', extra: 'PRAGMA synchronous=EXTRA' };
      const selected = this.db.prepare(journal[parsed.data.journalMode]).get()?.journal_mode;
      if (selected !== parsed.data.journalMode) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
      this.db.exec(durability[parsed.data.durability]);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Transaction may not have started. */ }
      this.db.close(); throw sqliteFailure(error);
    }
  }
  async loadBoundDispatch(identity: AttemptIdentity) {
    try { return readRunBoundDispatch(this.db, identity).dispatch; } catch (error) { throw sqliteFailure(error); }
  }
  async loadCancellationDispatch(identity: AttemptIdentity) {
    try { return loadCancellationDispatch(this.db, identity); } catch (error) { throw sqliteFailure(error); }
  }
  async loadRunReceipt(scopeId: string, commandId: string) { return new SqliteRunJournal(this.db).loadRunReceipt(scopeId, commandId); }
  async cancelRun(input: RunCancellation) { return new SqliteRunJournal(this.db).cancelRun(input); }
  async createExecutionPool(input: ExecutionPool) { return new SqliteRunJournal(this.db).createExecutionPool(input); }
  async projectRunAttempt(input: RunProjection) { return new SqliteRunJournal(this.db).projectRunAttempt(input); }
  async loadRun(scopeId: string, runId: string) { return new SqliteRunJournal(this.db).loadRun(scopeId, runId); }
  async createRun(input: RunCreate) { return new SqliteRunJournal(this.db).createRun(input); }
  async reserveRunTasks(input: RunReservation) { return new SqliteRunJournal(this.db).reserveRunTasks(input); }
  async listDispatches(query: DispatchInventoryQuery) { return new SqliteDispatchJournal(this.db).listDispatches(query); }
  async requestDispatchCancellation(request: DispatchClaim['request'], principal: VerifiedPrincipal) { return new SqliteDispatchJournal(this.db).requestDispatchCancellation(request, principal); }
  async retainDispatchOutput(claim: DispatchClaim, receipt: ArtifactReceipt) { return new SqliteDispatchJournal(this.db).retainDispatchOutput(claim, receipt); }
  async readDispatch(request: DispatchClaim['request']) { return new SqliteDispatchJournal(this.db).readDispatch(request); }
  async claimDispatch(claim: DispatchAdmission) { return new SqliteDispatchJournal(this.db, this.profiles).claimDispatch(claim); }
  async grantLaunch(input: LaunchRequest) { return new SqliteDispatchJournal(this.db).grantLaunch(input); }
  async finishDispatch(claim: DispatchClaim, terminal: DispatchTerminal) { return new SqliteDispatchJournal(this.db).finishDispatch(claim, terminal); }
  close(): void { this.db.close(); }
  async load(scopeId: string, attemptId: string) {
    let row;
    try { row = this.db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId); }
    catch (error) { throw sqliteFailure(error); }
    if (!row) return null;
    const snapshot = this.decode(row.snapshot);
    if (snapshot.identity.scopeId !== scopeId || snapshot.identity.attemptId !== attemptId) throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT');
    return snapshot;
  }
  async receipt(scopeId: string, commandId: string): Promise<AttemptReceipt | null> {
    try { return this.readReceipt(scopeId, commandId); } catch (error) { throw sqliteFailure(error); }
  }
  private decode(value: unknown) {
    try { return attemptSnapshotSchema.parse(JSON.parse(String(value))); }
    catch { throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT'); }
  }
  private readReceipt(scopeId: string, commandId: string): AttemptReceipt | null {
    const row = this.db.prepare('SELECT command, snapshot FROM attempt_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null;
    const snapshot = this.decode(row.snapshot);
    if (snapshot.identity.scopeId !== scopeId || typeof row.command !== 'string') throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT');
    return Object.freeze({ commandId, command: row.command, snapshot });
  }
  async commit(input: AttemptCommit): Promise<AttemptReceipt> {
    const snapshot = attemptSnapshotSchema.parse(input.snapshot);
    const { scopeId, attemptId } = snapshot.identity;
    const cancellationActor = input.cancellationActor === undefined ? undefined : verifiedPrincipalSchema.parse(input.cancellationActor);
    if (cancellationActor && (!cancellationActor.scopeIds.includes(scopeId) || !snapshot.cancelRequested || input.expectedRevision === null)) {
      throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT');
    }
    let transaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      transaction = true;
      const existing = this.readReceipt(scopeId, input.commandId);
      if (existing) {
        if (existing.command !== input.command) throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT');
        this.db.exec('COMMIT'); return existing;
      }
      const encoded = JSON.stringify(snapshot);
      if (input.expectedRevision !== null) {
        const currentRow = this.db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId);
        if (!currentRow) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
        const current = this.decode(currentRow.snapshot);
        if (!sameAttemptIdentity(current.identity, snapshot.identity) ||
          (snapshot.revision === input.expectedRevision && JSON.stringify(current) !== encoded)) {
          throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
        }
      }
      if (input.expectedRevision === null) {
        if (snapshot.revision !== 0) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
        const written = this.db.prepare('INSERT INTO attempts(scope_id,attempt_id,revision,snapshot) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
          .run(scopeId, attemptId, snapshot.revision, encoded);
        if (written.changes !== 1) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
      } else {
        if (snapshot.revision !== input.expectedRevision && snapshot.revision !== input.expectedRevision + 1) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
        const written = this.db.prepare('UPDATE attempts SET revision=?,snapshot=? WHERE scope_id=? AND attempt_id=? AND revision=?')
          .run(snapshot.revision, encoded, scopeId, attemptId, input.expectedRevision);
        if (written.changes !== 1) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
      }
      if (cancellationActor) {
        const dispatchRow = this.db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId);
        if (dispatchRow) {
          let dispatch;
          try { dispatch = dispatchRecordSchema.parse(JSON.parse(String(dispatchRow.record))); }
          catch { throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT'); }
          if (!sameAttemptIdentity(dispatch.request.identity, snapshot.identity)) throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT');
          const actor = { id: cancellationActor.id, issuer: cancellationActor.issuer, subject: cancellationActor.subject };
          if (dispatch.cancellation && JSON.stringify(dispatch.cancellation) !== JSON.stringify(actor)) {
            throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT');
          }
          const attributed = dispatchRecordSchema.parse({ ...dispatch, cancellation: actor });
          this.db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?')
            .run(JSON.stringify(attributed), scopeId, attemptId);
        }
      }
      this.db.prepare('INSERT INTO attempt_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,?)')
        .run(scopeId, input.commandId, input.command, encoded);
      this.db.exec('COMMIT');
      return Object.freeze({ commandId: input.commandId, command: input.command, snapshot });
    } catch (error) {
      if (transaction) {
        try { this.db.exec('ROLLBACK'); }
        catch { throw new AttemptStoreError('ATTEMPT_STORE_OUTCOME_UNKNOWN'); }
      }
      throw sqliteFailure(error);
    }
  }
}
