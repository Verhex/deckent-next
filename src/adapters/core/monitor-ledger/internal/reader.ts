import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { approvalRecordSchema, approvalSubject, runSnapshotSchema } from '#domain/index.js';
import { AttemptStoreError, dispatchRecordSchema, executionPoolSchema, measureTaskOccupancy, poolHoldRecordSchema, workerEventLogSchema,
  type MonitorLedgerApproval, type MonitorLedgerAttempt, type MonitorLedgerPool, type MonitorLedgerReading, type MonitorLedgerRun } from '#engine/index.js';
import { assertSqliteEngineSupported, CURRENT_LEDGER_VERSION, POOL_HOLD_LEDGER_VERSION, RUN_LEDGER_VERSION, sqliteFailure, WORKER_EVENT_LOG_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';

// First ledger versions of the optional evidence tables (schema.ts history): intents + evaluation observations, task approvals.
const INTENT_LEDGER_VERSION = 25, APPROVAL_LEDGER_VERSION = 31;
const OPEN_PHASES = "('pending','active','evaluating','reconciling')";
const optionsSchema = z.object({ busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647), maxRuns: z.number().int().positive().max(100_000) }).strict();
export type MonitorLedgerOptions = z.infer<typeof optionsSchema>;
const num = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const json = (value: unknown) => { try { return JSON.parse(String(value)) as unknown; } catch { return undefined; } };
/** A record that fails its schema is reported; an SQLite failure (busy, I/O, corruption) is never relabelled as one bad row. */
const recordOnly = (error: unknown) => { if (error && typeof error === 'object' && 'errcode' in error) throw error; };

/**
 * MONITOR-DATA: one read-only, version-aware view of an existing product ledger. The connection is `readOnly` (no create, migrate,
 * journal-mode change or write; a WAL reader may still use SQLite's shared-memory bookkeeping) and every read runs in one deferred read
 * transaction, so Runs, attempts, approvals and pools come from one snapshot. Tables newer than the ledger's version are skipped (their
 * fields stay null); corrupt rows become typed diagnostics. Non-terminal Runs come first, then the most recent; `maxRuns` bounds the set.
 */
export function readMonitorLedger(path: string, input: MonitorLedgerOptions): MonitorLedgerReading {
  const options = optionsSchema.safeParse(input);
  if (typeof path !== 'string' || !path || !options.success) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  assertSqliteEngineSupported(process.versions.sqlite);
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let db: DatabaseSync;
  try { db = new NativeDatabase(path, { readOnly: true, timeout: options.data.busyTimeoutMs }); } catch (error) { throw sqliteFailure(error); }
  try {
    db.exec('BEGIN');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (!Number.isSafeInteger(version) || version < RUN_LEDGER_VERSION || version > CURRENT_LEDGER_VERSION) {
      return Object.freeze({ ledgerVersion: version, scopeIds: [], runs: [], approvals: [], pools: [], diagnostics: ['ledger-version-unsupported:' + version] });
    }
    return read(db, version, options.data.maxRuns);
  } catch (error) { throw sqliteFailure(error); }
  finally { try { if (db.isTransaction) db.exec('ROLLBACK'); } finally { db.close(); } }
}

function read(db: DatabaseSync, version: number, maxRuns: number): MonitorLedgerReading {
  const diagnostics: string[] = version < CURRENT_LEDGER_VERSION ? ['ledger-version-older:' + version] : [];
  // One pass over run receipts (command text only; snapshots are not loaded): creation time per Run and reservation time per attempt.
  const created = new Map<string, number>(), reserved = new Map<string, number>();
  for (const row of db.prepare(`SELECT scope_id,command FROM run_receipts WHERE (CASE WHEN json_valid(command) THEN json_extract(command,'$.action') END)
    IN ('create-run','reserve-run-tasks')`).all()) {
    const command = json(row.command) as { action?: string; now?: unknown; identity?: { runId?: string }; identities?: { attemptId?: string }[] };
    const now = num(command?.now); if (now === null) continue;
    if (command.action === 'create-run') created.set(`${row.scope_id}/${command.identity?.runId}`, now);
    else for (const identity of command.identities ?? []) reserved.set(`${row.scope_id}/${identity?.attemptId}`, now);
  }
  const total = Number(db.prepare('SELECT count(*) AS n FROM runs').get()?.n);
  if (total > maxRuns) diagnostics.push('runs-truncated:' + total);
  const rows = db.prepare(`SELECT scope_id,run_id,revision,snapshot,CASE WHEN json_valid(policy) THEN json_extract(policy,'$.poolId') END AS pool_id,
    CASE WHEN json_valid(snapshot) THEN EXISTS(SELECT 1 FROM json_each(snapshot,'$.progress') p WHERE json_extract(p.value,'$.phase') IN ${OPEN_PHASES}) ELSE 1 END AS open
    FROM runs ORDER BY open DESC,rowid DESC LIMIT ?`).all(maxRuns);
  const runs: MonitorLedgerRun[] = [];
  for (const row of rows) {
    const key = `${row.scope_id}/${row.run_id}`;
    try {
      const snapshot = runSnapshotSchema.parse(json(row.snapshot));
      if (snapshot.identity.scopeId !== row.scope_id || snapshot.identity.runId !== row.run_id || snapshot.revision !== row.revision) throw new Error();
      const intent = version >= INTENT_LEDGER_VERSION ? db.prepare('SELECT admitted_at FROM run_execution_intents WHERE scope_id=? AND run_id=?').get(row.scope_id, row.run_id) : undefined;
      const attempts = snapshot.bindings.map(binding => attempt(db, version, binding, reserved.get(`${row.scope_id}/${binding.identity.attemptId}`) ?? null));
      runs.push(Object.freeze({ snapshot, poolId: typeof row.pool_id === 'string' ? row.pool_id : null, admitted: version >= INTENT_LEDGER_VERSION ? !!intent : null,
        createdAtMs: created.get(key) ?? num(intent?.admitted_at), attempts: Object.freeze(attempts) }));
    } catch (error) { recordOnly(error); diagnostics.push('run-corrupt:' + key); }
  }
  const approvals = version >= APPROVAL_LEDGER_VERSION ? pendingApprovals(db, maxRuns, diagnostics) : [];
  const scopes = new Set(db.prepare('SELECT DISTINCT scope_id FROM runs ORDER BY scope_id').all().map(row => String(row.scope_id)));
  for (const approval of approvals) scopes.add(approval.scopeId);
  return Object.freeze({ ledgerVersion: version, scopeIds: Object.freeze([...scopes].sort()), runs: Object.freeze(runs), approvals: Object.freeze(approvals),
    pools: Object.freeze(pools(db, version, diagnostics)), diagnostics: Object.freeze(diagnostics) });
}

function attempt(db: DatabaseSync, version: number, binding: MonitorLedgerRun['snapshot']['bindings'][number], reservedAtMs: number | null): MonitorLedgerAttempt {
  const { scopeId, runId, attemptId, generation } = binding.identity;
  const row = db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId);
  const record = row ? dispatchRecordSchema.parse(json(row.record)) : null;
  if (record && (record.request.identity.attemptId !== attemptId || record.request.identity.runId !== runId)) throw new Error();
  const evaluationObserved = version >= INTENT_LEDGER_VERSION && binding.observedRevision !== null && !!db.prepare(`SELECT 1 FROM task_evaluation_observations
    WHERE scope_id=? AND run_id=? AND attempt_id=? AND attempt_revision=?`).get(scopeId, runId, attemptId, binding.observedRevision);
  const log = version >= WORKER_EVENT_LOG_LEDGER_VERSION ? db.prepare('SELECT record FROM worker_event_logs WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId) : undefined;
  const sealed = log ? workerEventLogSchema.parse(json(log.record)) : null;
  return Object.freeze({ attemptId, generation, observedKind: binding.observedKind, observedRevision: binding.observedRevision, evaluationObserved, reservedAtMs,
    sealedAtMs: sealed && sealed.identity.attemptId === attemptId ? sealed.sealedAt : null,
    dispatch: record ? Object.freeze({ launch: record.launch, grantedAtMs: record.grant?.grantedAt ?? null, outputRecorded: !!record.output,
      terminal: record.terminal ? Object.freeze({ exitCode: record.terminal.exitCode, signal: record.terminal.signal ?? null, interrupted: record.terminal.interrupted }) : null }) : null });
}

/** Current pending approvals (status inside the sealed snapshot; the MAC is not verified here, so the summary is display data only). */
function pendingApprovals(db: DatabaseSync, limit: number, diagnostics: string[]): MonitorLedgerApproval[] {
  const rows = db.prepare(`SELECT scope_id,approval_id,snapshot FROM approvals WHERE current=1
    AND (CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.status') ELSE 'pending' END)='pending' ORDER BY scope_id,approval_id LIMIT ?`).all(limit + 1);
  if (rows.length > limit) diagnostics.push('approvals-truncated');
  return rows.slice(0, limit).flatMap(row => {
    try {
      const record = approvalRecordSchema.parse(json(row.snapshot)), request = record.request, subject = approvalSubject(request);
      if (request.scopeId !== row.scope_id || request.approvalId !== row.approval_id) throw new Error();
      return [Object.freeze({ scopeId: request.scopeId, approvalId: request.approvalId, subjectKind: subject.kind, runId: subject.kind === 'task' ? subject.runId : null,
        taskId: subject.kind === 'task' ? subject.taskId : null, summary: request.summary, createdAtMs: request.createdAt, expiresAtMs: request.expiresAt })];
    } catch (error) { recordOnly(error); diagnostics.push(`approval-corrupt:${row.scope_id}/${row.approval_id}`); return []; }
  });
}

/** Installation-wide pools: capacity from `execution_pools`, occupancy recomputed from every Run's progress (the reservation rule), hold (v44). */
function pools(db: DatabaseSync, version: number, diagnostics: string[]): MonitorLedgerPool[] {
  const occupancy = new Map<string, { execution: number; inFlight: number }>();
  for (const row of db.prepare(`SELECT CASE WHEN json_valid(policy) THEN json_extract(policy,'$.poolId') END AS pool_id,
    CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.progress') END AS progress FROM runs`).all()) {
    if (typeof row.pool_id !== 'string') continue;
    try {
      const measured = measureTaskOccupancy(json(row.progress)), sum = occupancy.get(row.pool_id) ?? { execution: 0, inFlight: 0 };
      occupancy.set(row.pool_id, { execution: sum.execution + measured.execution, inFlight: sum.inFlight + measured.inFlight });
    } catch { diagnostics.push('pool-occupancy-corrupt:' + row.pool_id); }
  }
  return db.prepare('SELECT pool_id,policy FROM execution_pools ORDER BY pool_id').all().flatMap(row => {
    try {
      const pool = executionPoolSchema.parse(json(row.policy)); if (pool.poolId !== row.pool_id) throw new Error();
      const held = version >= POOL_HOLD_LEDGER_VERSION ? db.prepare('SELECT state,record FROM execution_pool_holds WHERE pool_id=?').get(pool.poolId) : undefined;
      const hold = held ? poolHoldRecordSchema.parse(json(held.record)) : null;
      if (hold && (hold.poolId !== pool.poolId || hold.state !== held!.state)) throw new Error();
      const used = occupancy.get(pool.poolId) ?? { execution: 0, inFlight: 0 };
      return [Object.freeze({ poolId: pool.poolId, executionSlots: pool.capacity.executionSlots, inFlightSlots: pool.capacity.inFlightSlots, ...used,
        hold: hold ? Object.freeze({ state: hold.state, changedAtMs: hold.changedAtMs, changedBy: hold.changedBy.subject }) : null })];
    } catch (error) { recordOnly(error); diagnostics.push('pool-corrupt:' + row.pool_id); return []; }
  });
}
