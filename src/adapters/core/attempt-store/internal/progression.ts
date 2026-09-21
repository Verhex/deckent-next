import type { DatabaseSync } from 'node:sqlite';
import { attemptIdentitySchema, counterSchema } from '#domain/index.js';
import { progressionQuerySchema, progressionCursorSchema, type ProgressionQuery, type ProgressionCursor } from '#engine/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';

/** Trusted local host discovery. Actor selection is identity matching, not an execution grant. */
export class SqliteRunProgression {
  constructor(private readonly db: DatabaseSync) {}
  async listRunProgression(input: ProgressionQuery) {
    const query = progressionQuerySchema.parse(input);
    try {
      const rows = this.db.prepare(`SELECT i.scope_id,i.run_id FROM run_execution_intents i
        JOIN runs r ON r.scope_id=i.scope_id AND r.run_id=i.run_id
        WHERE i.actor_id=? AND i.issuer=? AND i.subject=?
          AND (? IS NULL OR (i.scope_id,i.run_id)>(?,?))
          AND json_extract(r.snapshot,'$.cancelRequested')=0
          AND EXISTS (SELECT 1 FROM json_each(r.snapshot,'$.progress') p
            WHERE json_extract(p.value,'$.phase') IN ('pending','active','evaluating','reconciling'))
        ORDER BY i.scope_id,i.run_id LIMIT ?`).all(query.actor.id, query.actor.issuer, query.actor.subject,
        query.after?.scopeId ?? null, query.after?.scopeId ?? null, query.after?.runId ?? null, query.limit + 1);
      const items = rows.slice(0, query.limit).map(row => progressionCursorSchema.parse({ scopeId: row.scope_id, runId: row.run_id }));
      return Object.freeze({ items: Object.freeze(items), next: rows.length > query.limit ? items.at(-1)! : null as ProgressionCursor | null });
    } catch (error) { throw sqliteFailure(error); }
  }
  async hasTaskEvaluation(identityInput: unknown, revisionInput: number) {
    const identity = attemptIdentitySchema.parse(identityInput), revision = counterSchema.positive().parse(revisionInput);
    try { return !!this.db.prepare(`SELECT 1 FROM task_evaluation_observations
      WHERE scope_id=? AND run_id=? AND attempt_id=? AND attempt_revision=?`).get(identity.scopeId, identity.runId, identity.attemptId, revision); }
    catch (error) { throw sqliteFailure(error); }
  }
}
