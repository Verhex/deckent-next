import { DatabaseSync } from 'node:sqlite';
import { attemptSnapshotSchema } from '#domain/index.js';
import { AttemptStoreError, type AttemptCommit, type AttemptReceipt, type AttemptStore } from '#engine/index.js';

/** Dedicated execution database. Path ownership/permissions are established by composition, not this adapter. */
export class SqliteAttemptStore implements AttemptStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
      if (version === 0) this.db.exec(`
        CREATE TABLE attempts(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision INTEGER NOT NULL,
          snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id));
        CREATE TABLE attempt_receipts(scope_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL,
          snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, command_id));
        PRAGMA user_version = 1;
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Transaction may not have started. */ }
      this.db.close(); throw error;
    }
  }
  close(): void { this.db.close(); }
  async load(scopeId: string, attemptId: string) {
    const row = this.db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId);
    if (!row) return null;
    const snapshot = this.decode(row.snapshot);
    if (snapshot.identity.scopeId !== scopeId || snapshot.identity.attemptId !== attemptId) throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT');
    return snapshot;
  }
  async receipt(scopeId: string, commandId: string): Promise<AttemptReceipt | null> {
    return this.readReceipt(scopeId, commandId);
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
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
        if (JSON.stringify(current.identity) !== JSON.stringify(snapshot.identity) ||
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
      this.db.prepare('INSERT INTO attempt_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,?)')
        .run(scopeId, input.commandId, input.command, encoded);
      this.db.exec('COMMIT');
      return Object.freeze({ commandId: input.commandId, command: input.command, snapshot });
    } catch (error) {
      this.db.exec('ROLLBACK'); throw error;
    }
  }
}
