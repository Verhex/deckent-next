import type { DatabaseSync } from 'node:sqlite';
import { identitySchema } from '#domain/index.js';
import { workspaceCustodyConflict, assertRunExecution, runWorkspaceCustodySchema, RunWorkspaceCustodyError,
  type RunWorkspaceCustody, type RunWorkspaceCustodyStore } from '#engine/index.js';
import { decodeLedgerRunSnapshot, ledgerTransaction, sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';

export class SqliteRunWorkspaceCustody implements RunWorkspaceCustodyStore {
  constructor(private readonly db: DatabaseSync) {}
  private read(scopeId: string, runId: string) {
    const row = this.db.prepare('SELECT record FROM run_workspace_custody WHERE scope_id=? AND run_id=?').get(scopeId, runId);
    if (!row) return null;
    try {
      const record = runWorkspaceCustodySchema.parse(JSON.parse(String(row.record)));
      if (record.scopeId !== scopeId || record.runId !== runId) throw new Error('IDENTITY_MISMATCH');
      return record;
    } catch { throw new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CORRUPT'); }
  }
  private requireRun(scopeId: string, runId: string) {
    const row = this.db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
    if (!row) throw new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CONFLICT');
    decodeLedgerRunSnapshot(row.snapshot, scopeId, runId, () => new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CORRUPT'),
      run => { assertRunExecution(run.graph, run.execution); return run.revision === row.revision; });
  }
  /** Inside the caller's transaction, right after the Run row: the Run's first and only custody. Any existing record conflicts. */
  admitWithin(input: RunWorkspaceCustody): RunWorkspaceCustody {
    const candidate = runWorkspaceCustodySchema.parse(input); this.requireRun(candidate.scopeId, candidate.runId);
    if (this.read(candidate.scopeId, candidate.runId)) throw new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CONFLICT');
    this.db.prepare('INSERT INTO run_workspace_custody(scope_id,run_id,record) VALUES(?,?,?)')
      .run(candidate.scopeId, candidate.runId, JSON.stringify(candidate));
    const recorded = this.read(candidate.scopeId, candidate.runId);
    if (!recorded || JSON.stringify(recorded) !== JSON.stringify(candidate)) throw new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CORRUPT');
    return recorded;
  }
  /** Inside the caller's transaction: the recorded custody equals `candidate` exactly (source and base revision). */
  matchesWithin(candidate: RunWorkspaceCustody): boolean {
    return JSON.stringify(this.read(candidate.scopeId, candidate.runId)) === JSON.stringify(runWorkspaceCustodySchema.parse(candidate));
  }
  async loadRunWorkspaceCustody(scopeInput: string, runInput: string) {
    const scopeId = identitySchema.parse(scopeInput), runId = identitySchema.parse(runInput);
    try { this.requireRun(scopeId, runId); return this.read(scopeId, runId); }
    catch (error) { throw sqliteFailure(error); }
  }
  async resolveRunWorkspaceCustody(input: RunWorkspaceCustody) {
    const candidate = runWorkspaceCustodySchema.parse(input);
    return ledgerTransaction(this.db, () => {
      this.requireRun(candidate.scopeId, candidate.runId);
      let recorded = this.read(candidate.scopeId, candidate.runId);
      if (!recorded) {
        this.db.prepare('INSERT INTO run_workspace_custody(scope_id,run_id,record) VALUES(?,?,?)')
          .run(candidate.scopeId, candidate.runId, JSON.stringify(candidate));
        recorded = this.read(candidate.scopeId, candidate.runId);
      }
      if (!recorded || JSON.stringify(recorded.source) !== JSON.stringify(candidate.source)) {
        throw recorded ? workspaceCustodyConflict(recorded.source, candidate.source)
          : new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CONFLICT');
      }
      return recorded;
    });
  }
}
