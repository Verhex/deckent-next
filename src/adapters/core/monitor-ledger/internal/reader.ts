import { readQuotaHolds } from '#adapters/core/sqlite-ledger/index.js';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { approvalRecordSchema, approvalSubject, sameAttemptIdentity, parseModelCatalogModelRecord, parseModelCatalogChannelRecord, readWorkerModelPin, runSnapshotSchema, taskEvaluationModelSchema, type AttemptIdentity, type WorkerModelView, type RunSnapshot } from '#domain/index.js';
import type { ArtifactReceipt } from '#capabilities/index.js';
import { poolCapacityReceiptSchema, runExecutionPolicySchema, AttemptStoreError, handoffEventCommandId, handoffStartRecordSchema, workerTreeExclusionCommandId, workerTreeExclusionRecordSchema, dispatchRecordSchema, executionPoolSchema, measureTaskOccupancy, poolHoldRecordSchema, workerEventLogSchema,
  type MonitorLedgerApproval, type MonitorLedgerAttempt, type MonitorLedgerPool, type MonitorLedgerReading, type MonitorLedgerRun, type MonitorMap } from '#engine/index.js';
import { readRunAcceptanceMetrics, readRunAcceptanceEvaluations, readAcceptanceEvaluationRows, assertSqliteEngineSupported, CURRENT_LEDGER_VERSION, POOL_CAPACITY_LEDGER_VERSION, POOL_HOLD_LEDGER_VERSION, RUN_LEDGER_VERSION, sqliteFailure, WORKER_EVENT_LOG_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { aggregateDelivery, readDeliveryReceipts } from './receipt-observation.js';

// First ledger versions of the optional evidence tables (schema.ts history): intents + evaluation observations, task approvals.
const INTENT_LEDGER_VERSION = 25, APPROVAL_LEDGER_VERSION = 31, CATALOG_VERSION = 43;
/** MONITOR v1.1: where an attempt's recorded files live (output envelope, sealed event log, workspace sidecars) and whether it failed or still runs. */
export interface MonitorAttemptFiles {
  readonly identity: AttemptIdentity; readonly patch?: ArtifactReceipt | null; readonly output: ArtifactReceipt | null; readonly events: ArtifactReceipt | null; readonly workspace: string | null;
  readonly failed: boolean; readonly open: boolean; readonly finished: boolean; readonly sealed: boolean;
}

const OPEN_PHASES = "('pending','active','evaluating','reconciling','awaiting-decision')";
const optionsSchema = z.object({ busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647), maxRuns: z.number().int().positive().max(100_000), run: z.object({ scopeId: z.string(), runId: z.string() }).strict().optional() }).strict();
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
export function readMonitorLedger(path: string, input: MonitorLedgerOptions): MonitorLedgerReading { return scanMonitorLedger(path, input).reading; }
/** The same read plus the recorded-file locations of every bound attempt (for first failure and recent events, read after the transaction). */
export function scanMonitorLedger(path: string, input: MonitorLedgerOptions, retained?: RunSnapshot): { readonly reading: MonitorLedgerReading; readonly files: readonly MonitorAttemptFiles[] } {
  const options = optionsSchema.safeParse(input);
  if (typeof path !== 'string' || !path || !options.success) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  const pinned = retained ? runSnapshotSchema.parse(retained) : undefined;
  if (pinned && (pinned.identity.scopeId !== options.data.run?.scopeId || pinned.identity.runId !== options.data.run.runId)) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
  assertSqliteEngineSupported(process.versions.sqlite);
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let db: DatabaseSync;
  try { db = new NativeDatabase(path, { readOnly: true, timeout: options.data.busyTimeoutMs }); } catch (error) { throw sqliteFailure(error); }
  try {
    db.exec('BEGIN');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (!Number.isSafeInteger(version) || version < RUN_LEDGER_VERSION || version > CURRENT_LEDGER_VERSION) {
      return { reading: Object.freeze({ ledgerVersion: version, scopeIds: [], runs: [], approvals: [], pools: [], diagnostics: ['ledger-version-unsupported:' + version] }), files: [] };
    }
    const files: MonitorAttemptFiles[] = [];
    return { reading: read(db, version, options.data.maxRuns, files, options.data.run, pinned), files };
  } catch (error) { throw sqliteFailure(error); }
  finally { try { if (db.isTransaction) db.exec('ROLLBACK'); } finally { db.close(); } }
}

function read(db: DatabaseSync, version: number, maxRuns: number, files: MonitorAttemptFiles[], selected?: { scopeId: string; runId: string }, pinned?: RunSnapshot): MonitorLedgerReading {
  const diagnostics: string[] = version < CURRENT_LEDGER_VERSION ? ['info:ledger-version-older:' + version] : [];
  // One pass over run receipts (command text only; snapshots are not loaded): creation time per Run and reservation time per attempt.
  // MONITOR v1.1: the evaluation receipt also carries the worker model record (requested → init → usage → verdict) of pinned tasks.
  const created = new Map<string, number>(), reserved = new Map<string, number>(), models = new Map<string, WorkerModelView>();
  for (const row of db.prepare(`SELECT scope_id,command FROM run_receipts WHERE (CASE WHEN json_valid(command) THEN json_extract(command,'$.action') END)
    IN ('create-run','reserve-run-tasks','apply-task-evaluation')`).all()) {
    const command = json(row.command) as { action?: string; now?: unknown; identity?: { runId?: string }; identities?: { attemptId?: string }[];
      evaluation?: { identity?: { attemptId?: string }; model?: unknown } };
    if (command?.action === 'apply-task-evaluation') {
      const model = taskEvaluationModelSchema.safeParse(command.evaluation?.model);
      if (model.success) models.set(`${row.scope_id}/${command.evaluation?.identity?.attemptId}`, Object.freeze({ ...model.data, evidence: model.data.evidence === 'sealed' ? 'sealed' : 'none' }));
      continue;
    }
    const now = num(command?.now); if (now === null) continue;
    if (command.action === 'create-run') created.set(`${row.scope_id}/${command.identity?.runId}`, now);
    else for (const identity of command.identities ?? []) reserved.set(`${row.scope_id}/${identity?.attemptId}`, now);
  }
  const total = Number(db.prepare('SELECT count(*) AS n FROM runs').get()?.n);
  if (total > maxRuns) diagnostics.push('info:runs-truncated:' + total);
  const rows = db.prepare(`SELECT scope_id,run_id,revision,snapshot,policy,CASE WHEN json_valid(policy) THEN json_extract(policy,'$.poolId') END AS pool_id,
    CASE WHEN json_valid(snapshot) THEN EXISTS(SELECT 1 FROM json_each(snapshot,'$.progress') p WHERE json_extract(p.value,'$.phase') IN ${OPEN_PHASES}) ELSE 1 END AS open
    FROM runs ${selected ? 'WHERE scope_id=? AND run_id=?' : ''} ORDER BY open DESC,rowid DESC LIMIT ?`).all(...(selected ? [selected.scopeId, selected.runId, maxRuns] : [maxRuns]));
  const runs: MonitorLedgerRun[] = []; const deliveries = readDeliveryReceipts(db, version), evaluationRows = readAcceptanceEvaluationRows(db);
  for (const row of rows) {
    const key = `${row.scope_id}/${row.run_id}`;
    try {
      const raw = json(row.snapshot) as Record<string, unknown>;
      // Read-only compatibility projection; ledger45 alone owns the durable migration.
      const current = runSnapshotSchema.parse(version < 45 && raw?.schemaVersion === 3 && !Object.hasOwn(raw, 'state')
        ? { ...raw, schemaVersion: 4, state: { kind: 'running' } } : raw);
      if (current.identity.scopeId !== row.scope_id || current.identity.runId !== row.run_id || current.revision !== row.revision) throw new Error();
      // Evaluation replay selects its retained bindings and revision, never the current Run's later Tasks/acceptance.
      if (pinned && (pinned.identity.layoutRevision !== current.identity.layoutRevision || pinned.revision > current.revision)) throw new Error();
      const snapshot = pinned ?? current;
      const intent = version >= INTENT_LEDGER_VERSION ? db.prepare('SELECT admitted_at FROM run_execution_intents WHERE scope_id=? AND run_id=?').get(row.scope_id, row.run_id) : undefined;
      const found: MonitorAttemptFiles[] = [];
      const attempts = snapshot.bindings.map(binding => attempt(db, version, binding, reserved.get(`${row.scope_id}/${binding.identity.attemptId}`) ?? null,
        models.get(`${row.scope_id}/${binding.identity.attemptId}`) ?? null, snapshot.execution.tasks.find(task => task.taskId === binding.identity.taskId)?.profile.parameters, found));
      const policy = row.policy ? runExecutionPolicySchema.safeParse(json(row.policy)) : null;
      // Supplemental cost projection cannot invalidate the canonical Run or its producer acceptance receipt.
      let costMetrics: MonitorLedgerRun['costMetrics'];
      try { costMetrics = readRunAcceptanceMetrics(db, snapshot); }
      catch (error) { recordOnly(error); diagnostics.push('run-cost-unavailable:' + key); }
      runs.push(Object.freeze({ snapshot, quotaHolds: readQuotaHolds(db, snapshot, 0), ...(costMetrics ? { costMetrics } : {}), evaluations: readRunAcceptanceEvaluations(db, snapshot, evaluationRows.get(key) ?? []), ...(policy?.success ? { capacity: policy.data.capacity } : {}), poolId: typeof row.pool_id === 'string' ? row.pool_id : null, admitted: version >= INTENT_LEDGER_VERSION ? !!intent : null,
        createdAtMs: created.get(key) ?? num(intent?.admitted_at), attempts: Object.freeze(attempts),
        deliveryReceipts: Object.freeze(snapshot.revision === current.revision ? deliveries.get(key) ?? [] : []),
        delivery: snapshot.revision === current.revision ? aggregateDelivery(deliveries.get(key) ?? []) : null }));
      files.push(...found);
    } catch (error) { recordOnly(error); diagnostics.push('run-corrupt:' + key); }
  }
  const approvals = version >= APPROVAL_LEDGER_VERSION ? currentApprovals(db, maxRuns, diagnostics) : [];
  const scopes = new Set(db.prepare('SELECT DISTINCT scope_id FROM runs ORDER BY scope_id').all().map(row => String(row.scope_id)));
  for (const approval of approvals) scopes.add(approval.scopeId);
  return Object.freeze({ ledgerVersion: version, scopeIds: Object.freeze([...scopes].sort()), runs: Object.freeze(runs), approvals: Object.freeze(approvals),
    pools: Object.freeze(pools(db, version, diagnostics)), diagnostics: Object.freeze(diagnostics), map: catalog(db, version) });
}

/** Catalog metadata only. Composition supplies scoped invocation readiness; this adapter never guesses it from activation tables. */
function catalog(db: DatabaseSync, version: number): MonitorMap | null {
  if (version < CATALOG_VERSION) return null;
  const models = db.prepare(`SELECT m.channel_id,m.model_id,m.record,c.record AS channel_record
    FROM model_catalog_models m JOIN model_catalog_channels c ON c.channel_id=m.channel_id ORDER BY m.channel_id,m.model_id`).all();
  return Object.freeze({ config: [], registry: { profiles: [], kinds: [] }, policy: null, memory: { available: false },
    models: Object.freeze(models.map(row => {
      const { model } = parseModelCatalogModelRecord(JSON.parse(String(row.record)));
      const { channel } = parseModelCatalogChannelRecord(JSON.parse(String(row.channel_record)));
      return Object.freeze({ channelId: String(row.channel_id), modelId: String(row.model_id), active: false,
        vendorId: 'vendorId' in model ? model.vendorId : null, billing: 'billing' in channel ? channel.billing : null });
    })) });
}

function attempt(db: DatabaseSync, version: number, binding: MonitorLedgerRun['snapshot']['bindings'][number], reservedAtMs: number | null,
  evaluated: WorkerModelView | null, parameters: unknown, files: MonitorAttemptFiles[]): MonitorLedgerAttempt {
  const { scopeId, runId, attemptId, generation } = binding.identity;
  const row = db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId);
  const record = row ? dispatchRecordSchema.parse(json(row.record)) : null;
  if (record && !sameAttemptIdentity(record.request.identity, binding.identity)) throw new Error();
  const evaluationObserved = version >= INTENT_LEDGER_VERSION && binding.observedRevision !== null && !!db.prepare(`SELECT 1 FROM task_evaluation_observations
    WHERE scope_id=? AND run_id=? AND attempt_id=? AND attempt_revision=?`).get(scopeId, runId, attemptId, binding.observedRevision);
  const log = version >= WORKER_EVENT_LOG_LEDGER_VERSION ? db.prepare('SELECT record FROM worker_event_logs WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId) : undefined;
  const sealed = log ? workerEventLogSchema.parse(json(log.record)) : null;
  const receipt = db.prepare('SELECT command,snapshot FROM attempt_receipts WHERE scope_id=? AND command_id=?').get(scopeId, handoffEventCommandId(binding.identity));
  const handoffStart = receipt ? handoffStartRecordSchema.parse(json(receipt.command)) : null;
  if (handoffStart && (!sameAttemptIdentity(handoffStart.identity, binding.identity) || !sameAttemptIdentity((json(receipt!.snapshot) as { identity: AttemptIdentity }).identity, binding.identity))) throw new Error();
  if (sealed && !sameAttemptIdentity(sealed.identity, binding.identity)) throw new Error();
  const excludedRow = db.prepare('SELECT command FROM attempt_receipts WHERE scope_id=? AND command_id=?').get(scopeId, workerTreeExclusionCommandId(binding.identity));
  const treeExclusions = excludedRow ? workerTreeExclusionRecordSchema.parse(json(excludedRow.command)) : null;
  if (treeExclusions && !sameAttemptIdentity(treeExclusions.identity, binding.identity)) throw new Error();
  const terminal = record?.terminal ?? null, pin = readWorkerModelPin(parameters);
  const failed = !!terminal && (terminal.exitCode !== 0 || terminal.signal !== undefined || terminal.interrupted === true);
  files.push(Object.freeze({ identity: binding.identity, patch: record?.patch ?? null, output: record?.output ?? null, events: sealed?.identity.attemptId === attemptId ? sealed.events : null,
    workspace: record?.request.workspace ?? null, failed, open: record?.launch === 'granted' && !terminal, finished: !!terminal, sealed: !!sealed }));
  const evidenceModel = evaluated ?? (pin ? Object.freeze({ provider: pin.provider, evidenceCapability: pin.evidenceCapability, requested: pin.pin, init: null, usage: null, verdict: 'pending' as const, unexpected: [], evidence: 'none' as const }) : null);
  // Selection belongs to the frozen profile, independently of evaluation/usage evidence. Legacy pins remain absent.
  const model = evidenceModel && pin?.reasoningEffort ? Object.freeze({ ...evidenceModel, reasoningEffort: pin.reasoningEffort }) : evidenceModel;
  return Object.freeze({ attemptId, generation, ...(handoffStart ? { handoffStart } : {}), ...(treeExclusions ? { treeExclusions } : {}), observedKind: binding.observedKind, observedRevision: binding.observedRevision, evaluationObserved, reservedAtMs,
    provider: evaluated?.provider ?? pin?.provider ?? record?.profile.adapterId ?? null, model,
    sealedAtMs: sealed && sealed.identity.attemptId === attemptId ? sealed.sealedAt : null,
    dispatch: record ? Object.freeze({ launch: record.launch, grantedAtMs: record.grant?.grantedAt ?? null, outputRecorded: !!record.output, patchRecorded: !!record.patch,
      terminal: record.terminal ? Object.freeze({ ...(record.terminal.container ? { container: record.terminal.container } : {}), exitCode: record.terminal.exitCode, signal: record.terminal.signal ?? null, interrupted: record.terminal.interrupted }) : null }) : null });
}

/** Current approvals retain decided/expired history. Pending requests and newest expiry lead the bounded page;
 * status is inside the sealed snapshot (the MAC is not verified here, so summary is display data only). */
function currentApprovals(db: DatabaseSync, limit: number, diagnostics: string[]): MonitorLedgerApproval[] {
  const rows = db.prepare(`SELECT scope_id,approval_id,snapshot FROM approvals WHERE current=1
    ORDER BY (CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.status')='pending' ELSE 1 END) DESC,
    (CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.request.expiresAt') END) DESC,scope_id,approval_id LIMIT ?`).all(limit + 1);
  if (rows.length > limit) diagnostics.push('info:approvals-truncated');
  return rows.slice(0, limit).flatMap(row => {
    try {
      const record = approvalRecordSchema.parse(json(row.snapshot)), request = record.request, subject = approvalSubject(request);
      if (request.scopeId !== row.scope_id || request.approvalId !== row.approval_id) throw new Error();
      return [Object.freeze({ status: record.status, scopeId: request.scopeId, approvalId: request.approvalId, subjectKind: subject.kind, runId: subject.kind === 'task' || subject.kind === 'run-create' ? subject.runId : null,
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
      const changed = version >= POOL_CAPACITY_LEDGER_VERSION ? db.prepare('SELECT record FROM execution_pool_capacities WHERE pool_id=?').get(pool.poolId) : null;
      const receipt = changed ? poolCapacityReceiptSchema.parse(json(changed.record)) : null;
      if (receipt && (receipt.poolId !== pool.poolId || !receipt.changed)) throw new Error();
      const capacity = receipt?.next ?? pool.capacity;
      const held = version >= POOL_HOLD_LEDGER_VERSION ? db.prepare('SELECT state,record FROM execution_pool_holds WHERE pool_id=?').get(pool.poolId) : undefined;
      const hold = held ? poolHoldRecordSchema.parse(json(held.record)) : null;
      if (hold && (hold.poolId !== pool.poolId || hold.state !== held!.state)) throw new Error();
      const used = occupancy.get(pool.poolId) ?? { execution: 0, inFlight: 0 };
      return [Object.freeze({ poolId: pool.poolId, executionSlots: capacity.executionSlots, inFlightSlots: capacity.inFlightSlots, ...used,
        hold: hold ? Object.freeze({ state: hold.state, changedAtMs: hold.changedAtMs, changedBy: hold.changedBy.subject }) : null })];
    } catch (error) { recordOnly(error); diagnostics.push('pool-corrupt:' + row.pool_id); return []; }
  });
}
