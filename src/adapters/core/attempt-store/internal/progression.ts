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
          AND (? IS NULL OR (i.scope_id,i.run_id)>(?,?)) AND (? IS NULL OR EXISTS (SELECT 1 FROM scope_registry s WHERE s.scope_id=i.scope_id AND s.company_id=?))
          AND json_extract(r.snapshot,'$.cancelRequested')=0
          AND (json_extract(r.snapshot,'$.state.kind')='running'
            OR (json_extract(r.snapshot,'$.state.kind')='parked' AND json_extract(r.snapshot,'$.state.reason') IN ('operator-hold','needs-input')
              AND EXISTS (SELECT 1 FROM json_each(r.snapshot,'$.progress') p WHERE json_extract(p.value,'$.phase') IN ('active','evaluating','reconciling'))))
          AND EXISTS (SELECT 1 FROM json_each(r.snapshot,'$.progress') p
            WHERE json_extract(p.value,'$.phase') IN ('pending','active','evaluating','reconciling'))
        ORDER BY i.scope_id,i.run_id LIMIT ?`).all(query.actor.id, query.actor.issuer, query.actor.subject,
        query.after?.scopeId ?? null, query.after?.scopeId ?? null, query.after?.runId ?? null, query.companyId ?? null, query.companyId ?? null, query.limit + 1);
      const items = rows.slice(0, query.limit).map(row => progressionCursorSchema.parse({ scopeId: row.scope_id, runId: row.run_id }));
      return Object.freeze({ items: Object.freeze(items), next: rows.length > query.limit ? items.at(-1)! : null as ProgressionCursor | null });
    } catch (error) { throw sqliteFailure(error); }
  }
  /** Deadlines are a separate bounded scan: parked Runs never re-enter worker reservation discovery. */
  async listRunLifecycleDue(input: ProgressionQuery & { readonly now: number }) {
    const { now, ...queryInput } = input;
    const query = progressionQuerySchema.parse(queryInput), time = counterSchema.parse(now);
    try {
      const rows = this.db.prepare(`SELECT i.scope_id,i.run_id FROM run_execution_intents i
        JOIN runs r ON r.scope_id=i.scope_id AND r.run_id=i.run_id
        WHERE i.actor_id=? AND i.issuer=? AND i.subject=?
          AND (? IS NULL OR (i.scope_id,i.run_id)>(?,?)) AND (? IS NULL OR EXISTS (SELECT 1 FROM scope_registry s WHERE s.scope_id=i.scope_id AND s.company_id=?))
          AND json_extract(r.snapshot,'$.state.kind')!='terminal'
          AND ((json_extract(r.snapshot,'$.state.kind')='parked' AND json_extract(r.snapshot,'$.state.deadline')<=?)
            OR EXISTS (SELECT 1 FROM json_each(r.snapshot,'$.progress') p
              WHERE json_extract(p.value,'$.phase')='awaiting-decision' AND json_extract(p.value,'$.decision.deadline')<=?))
        ORDER BY i.scope_id,i.run_id LIMIT ?`).all(query.actor.id, query.actor.issuer, query.actor.subject,
        query.after?.scopeId ?? null, query.after?.scopeId ?? null, query.after?.runId ?? null, query.companyId ?? null, query.companyId ?? null, time, time, query.limit + 1);
      const items = rows.slice(0, query.limit).map(row => progressionCursorSchema.parse({ scopeId: row.scope_id, runId: row.run_id }));
      return Object.freeze({ items: Object.freeze(items), next: rows.length > query.limit ? items.at(-1)! : null as ProgressionCursor | null });
    } catch (error) { throw sqliteFailure(error); }
  }
  /** Scopes of this actor's unfinished Runs not registered to `companyId` (one row per scope, bounded), for one typed note. */
  async listForeignProgressionScopes(input: { readonly actor: ProgressionQuery['actor']; readonly companyId: string; readonly limit: number }) {
    const { actor, companyId, limit } = progressionQuerySchema.required({ companyId: true }).parse({ ...input, after: null });
    try { return Object.freeze(this.db.prepare(`SELECT DISTINCT i.scope_id AS scope_id, s.company_id AS company_id FROM run_execution_intents i JOIN runs r ON r.scope_id=i.scope_id AND r.run_id=i.run_id LEFT JOIN scope_registry s ON s.scope_id=i.scope_id WHERE i.actor_id=? AND i.issuer=? AND i.subject=? AND json_extract(r.snapshot,'$.state.kind')!='terminal' AND (s.company_id IS NULL OR s.company_id!=?) ORDER BY i.scope_id LIMIT ?`).all(actor.id, actor.issuer, actor.subject, companyId, limit)
      .map(row => Object.freeze({ scopeId: progressionCursorSchema.shape.scopeId.parse(row.scope_id), reason: row.company_id === null ? 'unregistered' as const : 'foreign' as const }))); }
    catch (error) { throw sqliteFailure(error); }
  }
  async hasTaskEvaluation(identityInput: unknown, revisionInput: number) {
    const identity = attemptIdentitySchema.parse(identityInput), revision = counterSchema.positive().parse(revisionInput);
    try { return !!this.db.prepare(`SELECT 1 FROM task_evaluation_observations
      WHERE scope_id=? AND run_id=? AND attempt_id=? AND attempt_revision=?`).get(identity.scopeId, identity.runId, identity.attemptId, revision); }
    catch (error) { throw sqliteFailure(error); }
  }
}
