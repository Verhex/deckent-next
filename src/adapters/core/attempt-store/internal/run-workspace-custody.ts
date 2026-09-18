import type { DatabaseSync } from 'node:sqlite';
import { identitySchema, runSnapshotSchema } from '#domain/index.js';
import { assertRunExecution, runWorkspaceCustodySchema, RunWorkspaceCustodyError,
  type RunWorkspaceCustody, type RunWorkspaceCustodyStore } from '#engine/index.js';
import { sqliteFailure } from './options.js';

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
    try {
      const run = runSnapshotSchema.parse(JSON.parse(String(row.snapshot)));
      if (run.identity.scopeId !== scopeId || run.identity.runId !== runId || run.revision !== row.revision) throw new Error('IDENTITY_MISMATCH');
      assertRunExecution(run.graph, run.execution);
    } catch { throw new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CORRUPT'); }
  }
  async loadRunWorkspaceCustody(scopeInput: string, runInput: string) {
    const scopeId = identitySchema.parse(scopeInput), runId = identitySchema.parse(runInput);
    try { this.requireRun(scopeId, runId); return this.read(scopeId, runId); }
    catch (error) { throw sqliteFailure(error); }
  }
  async resolveRunWorkspaceCustody(input: RunWorkspaceCustody) {
    const candidate = runWorkspaceCustodySchema.parse(input); let active = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); active = true; this.requireRun(candidate.scopeId, candidate.runId);
      let recorded = this.read(candidate.scopeId, candidate.runId);
      if (!recorded) {
        this.db.prepare('INSERT INTO run_workspace_custody(scope_id,run_id,record) VALUES(?,?,?)')
          .run(candidate.scopeId, candidate.runId, JSON.stringify(candidate));
        recorded = this.read(candidate.scopeId, candidate.runId);
      }
      if (!recorded || JSON.stringify(recorded.source) !== JSON.stringify(candidate.source)) {
        throw new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CONFLICT');
      }
      this.db.exec('COMMIT'); return recorded;
    } catch (error) {
      if (active) { try { this.db.exec('ROLLBACK'); } catch { throw new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CORRUPT'); } }
      throw sqliteFailure(error);
    }
  }
}
