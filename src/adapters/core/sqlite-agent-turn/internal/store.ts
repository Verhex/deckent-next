import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AgentTurnStoreError, AGENT_TURN_ANSWER_MAX_BYTES, AGENT_TURN_INTERRUPTED_NOTE, type AgentTurnClaim, type AgentTurnOutcome, type AgentTurnStore,
  type AgentTurnToolCallRecord } from '#engine/index.js';

const id = z.string().min(1).max(256), count = z.number().int().nonnegative().safe(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const outcomeSchema = z.object({ finish: z.enum(['stop', 'length', 'cancelled', 'error']), note: z.string().max(4096).nullable(), rounds: count, toolCalls: count,
  answer: z.string().nullable(), answerBytes: count, appendedDigest: digest.nullable() }).strict()
  .refine(outcome => outcome.answer === null ? outcome.answerBytes === 0 || outcome.answerBytes > AGENT_TURN_ANSWER_MAX_BYTES
    : Buffer.byteLength(outcome.answer, 'utf8') === outcome.answerBytes && outcome.answerBytes <= AGENT_TURN_ANSWER_MAX_BYTES);
const turnSchema = z.object({ schemaVersion: z.literal(1), scopeId: id, turnId: id, principalKey: id, requestDigest: digest, claimedAtMs: count,
  finishedAtMs: count.nullable(), outcome: outcomeSchema.nullable() }).strict()
  .refine(turn => (turn.finishedAtMs === null) === (turn.outcome === null));
const callSchema = z.object({ schemaVersion: z.literal(1), scopeId: id, turnId: id, round: z.number().int().positive().safe(), index: count,
  callId: id, tool: z.string().min(1).max(64), toolVersion: count, argsDigest: digest.nullable(), target: z.string().max(4096).nullable(),
  status: z.enum(['ok', 'error', 'denied', 'approval-required', 'invalid-arguments', 'duplicate', 'cancelled']), bytes: count, resultDigest: digest, atMs: count }).strict();
type Turn = z.infer<typeof turnSchema>;

/** SQLite agent turn store (ledger v37). Every transition is one transaction; rows are validated when read and written. */
export class SqliteAgentTurnStore implements AgentTurnStore {
  constructor(private readonly db: DatabaseSync) {}
  close() { this.db.close(); }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw error; }
  }
  private load(scopeId: string, turnId: string): Turn | null {
    const row = this.db.prepare('SELECT scope_id,turn_id,principal_key,request_digest,state,record FROM agent_turns WHERE scope_id=? AND turn_id=?')
      .get(scopeId, turnId) as Record<string, unknown> | undefined;
    if (!row) return null;
    try {
      const turn = turnSchema.parse(JSON.parse(String(row['record'])));
      if (turn.scopeId !== row['scope_id'] || turn.turnId !== row['turn_id'] || turn.principalKey !== row['principal_key'] || turn.requestDigest !== row['request_digest']
        || row['state'] !== (turn.outcome ? 'finished' : 'running')) throw new Error();
      return turn;
    } catch { throw new AgentTurnStoreError('AGENT_TURN_CORRUPT'); }
  }
  private guard<T>(work: () => T): T {
    try { return work(); }
    catch (error) {
      if (error instanceof AgentTurnStoreError) throw error;
      // A record that fails its schema on write is the caller's invalid input, not an unavailable store.
      throw new AgentTurnStoreError(error instanceof z.ZodError ? 'AGENT_TURN_INVALID' : 'AGENT_TURN_UNAVAILABLE');
    }
  }
  async claim(claim: AgentTurnClaim) {
    return this.guard(() => this.transaction(() => {
      const current = this.load(claim.scopeId, claim.turnId);
      if (current) {
        if (current.principalKey !== claim.principalKey || current.requestDigest !== claim.requestDigest) throw new AgentTurnStoreError('AGENT_TURN_CONFLICT');
        if (!current.outcome) throw new AgentTurnStoreError('AGENT_TURN_IN_PROGRESS');
        return { status: 'finished' as const, outcome: Object.freeze(current.outcome) as AgentTurnOutcome };
      }
      const turn = turnSchema.parse({ schemaVersion: 1, scopeId: claim.scopeId, turnId: claim.turnId, principalKey: claim.principalKey,
        requestDigest: claim.requestDigest, claimedAtMs: claim.claimedAtMs, finishedAtMs: null, outcome: null });
      this.db.prepare('INSERT INTO agent_turns(scope_id,turn_id,principal_key,request_digest,state,record) VALUES(?,?,?,?,?,?)')
        .run(turn.scopeId, turn.turnId, turn.principalKey, turn.requestDigest, 'running', JSON.stringify(turn));
      return { status: 'new' as const };
    }));
  }
  async recordToolCall(record: AgentTurnToolCallRecord) {
    this.guard(() => this.transaction(() => {
      const turn = this.load(record.scopeId, record.turnId);
      if (!turn || turn.outcome) throw new AgentTurnStoreError('AGENT_TURN_CONFLICT');
      const parsed = callSchema.parse({ schemaVersion: 1, ...record });
      if (this.db.prepare('SELECT 1 FROM agent_turn_tool_calls WHERE scope_id=? AND turn_id=? AND round=? AND call_index=?')
        .get(parsed.scopeId, parsed.turnId, parsed.round, parsed.index)) throw new AgentTurnStoreError('AGENT_TURN_CONFLICT');
      this.db.prepare('INSERT INTO agent_turn_tool_calls(scope_id,turn_id,round,call_index,record) VALUES(?,?,?,?,?)')
        .run(parsed.scopeId, parsed.turnId, parsed.round, parsed.index, JSON.stringify(parsed));
    }));
  }
  async finish(scopeId: string, turnId: string, outcome: AgentTurnOutcome, atMs: number) {
    this.guard(() => this.transaction(() => {
      const turn = this.load(scopeId, turnId);
      if (!turn || turn.outcome) throw new AgentTurnStoreError('AGENT_TURN_CONFLICT');
      const finished = turnSchema.parse({ ...turn, finishedAtMs: atMs, outcome });
      const updated = this.db.prepare("UPDATE agent_turns SET state='finished',record=? WHERE scope_id=? AND turn_id=? AND state='running'")
        .run(JSON.stringify(finished), scopeId, turnId);
      if (updated.changes !== 1) throw new AgentTurnStoreError('AGENT_TURN_CONFLICT');
    }));
  }
  async interruptRunning(atMs: number) {
    return this.guard(() => this.transaction(() => {
      const rows = this.db.prepare("SELECT scope_id,turn_id FROM agent_turns WHERE state='running'").all() as { scope_id: string; turn_id: string }[];
      const corrupt: { scopeId: string; turnId: string }[] = [];
      for (const row of rows) {
        let turn: Turn;
        try { turn = this.load(row.scope_id, row.turn_id)!; }
        catch (error) {
          if (!(error instanceof AgentTurnStoreError) || error.code !== 'AGENT_TURN_CORRUPT') throw error;
          corrupt.push(Object.freeze({ scopeId: row.scope_id, turnId: row.turn_id })); continue;
        }
        const calls = (this.db.prepare('SELECT count(*) AS n FROM agent_turn_tool_calls WHERE scope_id=? AND turn_id=?').get(row.scope_id, row.turn_id) as { n: number }).n;
        const finished = turnSchema.parse({ ...turn, finishedAtMs: atMs, outcome: { finish: 'error', note: AGENT_TURN_INTERRUPTED_NOTE, rounds: 0, toolCalls: calls,
          answer: null, answerBytes: 0, appendedDigest: null } });
        this.db.prepare("UPDATE agent_turns SET state='finished',record=? WHERE scope_id=? AND turn_id=? AND state='running'").run(JSON.stringify(finished), row.scope_id, row.turn_id);
      }
      return Object.freeze({ interrupted: rows.length - corrupt.length, corrupt: Object.freeze(corrupt) });
    }));
  }
}

