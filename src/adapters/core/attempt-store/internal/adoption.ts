import type { DatabaseSync } from 'node:sqlite';
import { integrationAdoptionIntentSchema, WorkspaceAdoptionError, type IntegrationAdoptionIntent, type IntegrationAdoptionRecord, type AdoptionClaimObservation } from '#engine/index.js';
/** Rows recorded before ledger v58 carry no repository; only the fence chain that names them attributes them. Never written by a claim. */
const UNATTRIBUTED = 'pre-v58', repositoryId = /^[a-f0-9]{64}$/;
/** Adoption/rollback intents with a per-repository, per-target sequence fence (settled: 0 claimed, 1 applied, 2 released as not applied).
 * Git CAS guards the reference itself; this journal serializes Deckent's own commands on a repository's target and records which
 * adoption a rollback may still undo. */
export class SqliteAdoptionJournal {
  constructor(private readonly db: DatabaseSync) {}
  private decode(row: Record<string, unknown>, scopeId: string, commandId: string): IntegrationAdoptionRecord {
    let intent: IntegrationAdoptionIntent;
    try { intent = integrationAdoptionIntentSchema.parse(JSON.parse(String(row.intent))); }
    catch { throw new WorkspaceAdoptionError('ADOPTION_CORRUPT'); }
    if (intent.command.identity.scopeId !== scopeId || intent.command.commandId !== commandId || intent.kind !== row.kind
      || intent.targetRef !== row.target_ref || !Number.isSafeInteger(row.sequence) || ![0, 1, 2].includes(Number(row.settled))
      || (row.repository !== UNATTRIBUTED && !repositoryId.test(String(row.repository)))) {
      throw new WorkspaceAdoptionError('ADOPTION_CORRUPT');
    }
    return { intent, sequence: Number(row.sequence), settled: row.settled === 1, released: row.settled === 2, repository: row.repository === UNATTRIBUTED ? null : String(row.repository) };
  }
  /** Busy and fence agreement for one repository's target; synchronous, so a claim runs it under its writer. While a pre-v58 intent on the
   * target is unsettled every repository waits. The head is the repository's latest applied record; without one, a fence may only name the
   * pre-v58 chain's latest applied record (that repository continues it), and no fence starts a new chain. */
  private head(targetRef: string, { repository, fence }: AdoptionClaimObservation) {
    if (!repositoryId.test(repository)) throw new WorkspaceAdoptionError('ADOPTION_CORRUPT');
    if (this.db.prepare('SELECT 1 FROM workspace_adoptions WHERE target_ref=? AND settled=0 AND repository IN(?,?)').get(targetRef, repository, UNATTRIBUTED)) {
      throw new WorkspaceAdoptionError('ADOPTION_TARGET_BUSY');
    }
    const latest = (owner: string) => this.db.prepare('SELECT scope_id,command_id,sequence FROM workspace_adoptions WHERE repository=? AND target_ref=? AND settled=1 ORDER BY sequence DESC LIMIT 1').get(owner, targetRef);
    const head = latest(repository) ?? (fence ? latest(UNATTRIBUTED) : undefined);
    if (head ? !fence || fence.sequence !== head.sequence || fence.scopeId !== head.scope_id || fence.commandId !== head.command_id : fence) throw new WorkspaceAdoptionError('ADOPTION_FENCE_MISMATCH');
    return head;
  }
  async assertAdoptionFence(targetRef: string, observed: AdoptionClaimObservation) { this.head(targetRef, observed); }
  private read(scopeId: string, commandId: string) {
    const row = this.db.prepare('SELECT repository,target_ref,sequence,kind,intent,settled FROM workspace_adoptions WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    return row ? this.decode(row, scopeId, commandId) : null;
  }
  async loadAdoption(scopeId: string, commandId: string) { return this.read(scopeId, commandId); }
  async claimAdoption(input: IntegrationAdoptionIntent, observed: AdoptionClaimObservation): Promise<IntegrationAdoptionRecord> {
    const intent = integrationAdoptionIntentSchema.parse(input);
    const { scopeId } = intent.command.identity, { commandId } = intent.command;
    // All checks/mutations in the transaction are synchronous; no await while holding the writer.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.read(scopeId, commandId);
      if (existing) {
        if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
        if (existing.repository !== observed.repository) throw new WorkspaceAdoptionError('ADOPTION_REPOSITORY_CHANGED'); // Astra 2616 F2
        this.db.exec('COMMIT'); return existing;
      }
      const latest = this.head(intent.targetRef, observed);
      if (intent.kind === 'rollback') {
        const adopted = this.read(scopeId, intent.command.adoptionCommandId);
        if (!adopted || adopted.intent.kind !== 'adopt' || !adopted.settled || adopted.intent.targetRef !== intent.targetRef
          || adopted.intent.toCommit !== intent.fromCommit || adopted.intent.fromCommit !== intent.toCommit) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
        if (latest?.scope_id !== scopeId || latest?.command_id !== adopted.intent.command.commandId) throw new WorkspaceAdoptionError('ADOPTION_SUPERSEDED');
      }
      const sequence = latest ? Number(latest.sequence) + 1 : 1;
      if (!Number.isSafeInteger(sequence)) throw new WorkspaceAdoptionError('ADOPTION_CORRUPT');
      this.db.prepare('INSERT INTO workspace_adoptions(scope_id,command_id,repository,target_ref,sequence,kind,intent,settled) VALUES(?,?,?,?,?,?,?,0)')
        .run(scopeId, commandId, observed.repository, intent.targetRef, sequence, intent.kind, JSON.stringify(intent));
      this.db.exec('COMMIT'); return { intent, sequence, settled: false, released: false, repository: observed.repository };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async finishAdoption(input: IntegrationAdoptionIntent) { return this.settle(input, 1); }
  async releaseAdoption(input: IntegrationAdoptionIntent) { return this.settle(input, 2); }
  /** Claimed → applied (1) or released (2), once; replaying the same outcome returns the record, the other outcome is a conflict. */
  private settle(input: IntegrationAdoptionIntent, outcome: 1 | 2): IntegrationAdoptionRecord {
    const intent = integrationAdoptionIntentSchema.parse(input);
    const { scopeId } = intent.command.identity, { commandId } = intent.command;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare('UPDATE workspace_adoptions SET settled=? WHERE scope_id=? AND command_id=? AND intent=? AND settled=0')
        .run(outcome, scopeId, commandId, JSON.stringify(intent));
      const record = this.read(scopeId, commandId);
      if (!record || (outcome === 1 ? !record.settled : !record.released) || (changed.changes !== 1 && JSON.stringify(record.intent) !== JSON.stringify(intent))) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
      this.db.exec('COMMIT'); return record;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
