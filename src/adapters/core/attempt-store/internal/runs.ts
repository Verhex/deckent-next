import { propagateRunCancellation } from './run-cancellation.js';
import { settleRunCancellation } from './run-settlement.js';
import { SqliteExecutionPools } from './pools.js';
import type { RunAdmissionFilter } from '#engine/index.js';
import type { DatabaseSync } from 'node:sqlite';
import { readWorkerModelPin, identitySchema, requestRunCancellation, createRun, reserveRunTasks, runSnapshotSchema, createAttempt, attemptSnapshotSchema, reconcileRunLifecycle, observeRunAttempt, closesAttemptWithoutExit, RunError } from '#domain/index.js';
import { runCancellationSchema, type RunCancellation, runCreateSchema, runReservationSchema, runProjectionSchema, RunStoreError, AttemptStoreError, planSchedulingWave,
  assertRunExecution, assertTaskEvaluationCustody, diagnoseReservationWave, proposeTaskEvaluationCommit, taskEvaluationCommitSchema, type TaskEvaluationCommit, type ExecutionPool, runExecutionPolicySchema,
  type RunCreate, type RunReservation, type RunProjection, type RunReceipt } from '#engine/index.js';
import { readRunBoundDispatch } from './run-dispatch-lookup.js';
import { SqliteRunWorkspaceCustody } from './run-workspace-custody.js';
import { assertEvaluationDigests, readEvaluationDigests } from './evaluation-evidence.js';
import type { RunWorkspaceCustody } from '#engine/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { closeParkedRun, resumeParkedRun, expireParkedRun, parkTaskAwaitingDecision, resolveTaskDecision } from '#domain/index.js';
import { runLifecycleWriteSchema, RunLifecycleError, type RunLifecycleWrite, type AuditStore } from '#engine/index.js';
// Shared reads have no writer timing dependency and expose no mutation path.
function decodeRunSnapshot(snapshot: unknown, scopeId: string, runId: string) {
  try {
    const value = runSnapshotSchema.parse(JSON.parse(String(snapshot)));
    if (value.identity.scopeId !== scopeId || value.identity.runId !== runId) throw new RunStoreError('RUN_STORE_CORRUPT');
    return value;
  } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
}
export async function readRunReceipt(db: DatabaseSync, scopeInput: string, commandInput: string): Promise<RunReceipt | null> {
  const scopeId = identitySchema.parse(scopeInput); const commandId = identitySchema.parse(commandInput);
  try {
    const row = db.prepare('SELECT command,snapshot FROM run_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null;
    let snapshot;
    try { snapshot = runSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
    if (snapshot.identity.scopeId !== scopeId || typeof row.command !== 'string') throw new RunStoreError('RUN_STORE_CORRUPT');
    return Object.freeze({ commandId, command: row.command, snapshot });
  } catch (error) { throw sqliteFailure(error); }
}
export async function readRunSnapshot(db: DatabaseSync, scopeId: string, runId: string) {
  try {
    const row = db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
    if (!row) return null;
    const snapshot = decodeRunSnapshot(row.snapshot, scopeId, runId);
    if (snapshot.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
    return snapshot;
  } catch (error) { throw sqliteFailure(error); }
}
export class SqliteRunJournal {
  constructor(private readonly db: DatabaseSync, private readonly admission: Pick<RunAdmissionFilter, 'excluded'> | undefined,
    private readonly timing: { now: () => number; timeoutMs: number }, private readonly poolCeiling?: number) {}
  private transaction<T>(work: () => T): T {
    let active = false;
    try { this.db.exec('BEGIN IMMEDIATE'); active = true; const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) {
      if (active) { try { this.db.exec('ROLLBACK'); } catch { throw new AttemptStoreError('ATTEMPT_STORE_OUTCOME_UNKNOWN'); } }
      throw sqliteFailure(error);
    }
  }
  private receipt(scopeId: string, runId: string, commandId: string, command: string, matches: (prior: string) => boolean = prior => prior === command): RunReceipt | null {
    const row = this.db.prepare('SELECT command,snapshot FROM run_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null;
    if (typeof row.command !== 'string' || !matches(row.command)) throw new RunStoreError('RUN_COMMAND_CONFLICT');
    return Object.freeze({ commandId, command: row.command, snapshot: decodeRunSnapshot(row.snapshot, scopeId, runId) });
  }
  private record(receipt: RunReceipt): RunReceipt {
    this.db.prepare('INSERT INTO run_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,?)')
      .run(receipt.snapshot.identity.scopeId, receipt.commandId, receipt.command, JSON.stringify(receipt.snapshot));
    return Object.freeze(receipt);
  }
  async loadRunReceipt(scopeId: string, commandId: string) { return readRunReceipt(this.db, scopeId, commandId); }
  async createExecutionPool(input: ExecutionPool) { return this.transaction(() => new SqliteExecutionPools(this.db).create(input)); }
  async loadRun(scopeId: string, runId: string) { return readRunSnapshot(this.db, scopeId, runId); }
  async loadRunExecutionPolicy(scopeInput: string, runInput: string) {
    const scopeId = identitySchema.parse(scopeInput); const runId = identitySchema.parse(runInput);
    try {
      const row = this.db.prepare('SELECT revision,snapshot,policy FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
      if (!row) throw new RunStoreError('RUN_STORE_CONFLICT');
      const snapshot = decodeRunSnapshot(row.snapshot, scopeId, runId);
      if (snapshot.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
      try { assertRunExecution(snapshot.graph, snapshot.execution); return runExecutionPolicySchema.parse(JSON.parse(String(row.policy))); }
      catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
    } catch (error) { throw sqliteFailure(error); }
  }
  async projectRunAttempt(input: RunProjection): Promise<RunReceipt> {
    const parsed = runProjectionSchema.parse(input); const command = JSON.stringify({ action: 'project-run-attempt', ...parsed });
    const { scopeId, runId } = parsed;
    return this.transaction(() => {
      const replay = this.receipt(scopeId, runId, parsed.commandId, command); if (replay) return replay;
      const row = this.db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
      if (!row || row.revision !== parsed.expectedRevision) throw new RunStoreError('RUN_STORE_CONFLICT');
      const current = decodeRunSnapshot(row.snapshot, scopeId, runId);
      if (current.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
      const evidence = this.db.prepare('SELECT revision,snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(scopeId, parsed.attemptId);
      if (!evidence) throw new RunStoreError('RUN_STORE_CONFLICT');
      let attempt;
      try { attempt = attemptSnapshotSchema.parse(JSON.parse(String(evidence.snapshot))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
      if (attempt.revision !== evidence.revision || attempt.identity.scopeId !== scopeId || attempt.identity.attemptId !== parsed.attemptId) throw new RunStoreError('RUN_STORE_CORRUPT');
      const projected = observeRunAttempt(current, parsed.expectedRevision, attempt);
      const snapshot = closesAttemptWithoutExit(attempt.lastObservation?.result.kind) ? reconcileRunLifecycle(projected, this.timing.now(), this.timing.timeoutMs) : projected;
      const updated = this.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
        .run(snapshot.revision, JSON.stringify(snapshot), scopeId, runId, parsed.expectedRevision);
      if (updated.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      return this.record({ commandId: parsed.commandId, command, snapshot });
    });
  }
  async commitTaskEvaluation(input: TaskEvaluationCommit): Promise<RunReceipt> {
    const parsed = taskEvaluationCommitSchema.parse(input);
    const command = JSON.stringify({ action: 'apply-task-evaluation', ...parsed });
    const { scopeId, runId, attemptId } = parsed.evaluation.identity;
    return this.transaction(() => {
      const replay = this.receipt(scopeId, runId, parsed.commandId, command); if (replay) return replay;
      const { run, dispatch } = readRunBoundDispatch(this.db, parsed.evaluation.identity);
      if (!dispatch) throw new RunStoreError('RUN_STORE_CONFLICT');
      assertTaskEvaluationCustody(parsed.dispatch, dispatch);
      assertEvaluationDigests(this.db, parsed.evaluation);
      const row = this.db.prepare('SELECT revision,snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId);
      if (!row) throw new RunStoreError('RUN_STORE_CONFLICT');
      let attempt;
      try { attempt = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))); }
      catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
      if (attempt.revision !== row.revision || attempt.identity.scopeId !== scopeId || attempt.identity.attemptId !== attemptId) {
        throw new RunStoreError('RUN_STORE_CORRUPT');
      }
      const evaluation = { ...parsed.evaluation, evidenceDigests: parsed.evaluation.evidenceDigests ?? Object.values(readEvaluationDigests(this.db, parsed.evaluation.identity)).filter((value): value is string => value !== undefined) };
      const proposed = proposeTaskEvaluationCommit(run, attempt, dispatch, parsed.expectedRevision, evaluation,
        { now: parsed.now ?? this.timing.now(), timeoutMs: parsed.timeoutMs ?? this.timing.timeoutMs, ...(parsed.unknownDisposition ? { unknownDisposition: parsed.unknownDisposition } : {}) });
      const updated = this.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
        .run(proposed.snapshot.revision, JSON.stringify(proposed.snapshot), scopeId, runId, parsed.expectedRevision);
      if (updated.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      this.db.prepare('INSERT OR IGNORE INTO task_evaluation_observations(scope_id,run_id,attempt_id,attempt_revision) VALUES(?,?,?,?)')
        .run(scopeId, runId, attemptId, parsed.evaluation.attemptRevision);
      return this.record({ commandId: parsed.commandId, command, snapshot: proposed.snapshot });
    });
  }
  /** Decision, CAS snapshot, replay receipt and the sealed audit event share one transaction. */
  async commitRunLifecycle(input: RunLifecycleWrite, audit?: (store: AuditStore, snapshot: import('#domain/index.js').RunSnapshot) => void): Promise<RunReceipt> {
    const parsed = runLifecycleWriteSchema.parse(input), command = JSON.stringify({ operation: 'run-lifecycle', ...parsed });
    const { scopeId, runId, commandId, expectedRevision, now, timeoutMs } = parsed;
    const fingerprint = (encoded: string) => {
      const source = JSON.parse(encoded) as Record<string, unknown>;
      if (source.operation !== 'run-lifecycle') throw new RunStoreError('RUN_COMMAND_CONFLICT');
      delete source.operation;
      const data = { ...runLifecycleWriteSchema.parse(source) }; delete (data as Partial<RunLifecycleWrite>).now;
      delete (data as Partial<RunLifecycleWrite>).timeoutMs; return JSON.stringify(data);
    };
    if (['accept', 'reject'].includes(parsed.action) && (parsed.actor.assurance !== 'os-user' || !audit)) {
      throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
    }
    if (parsed.action === 'expire') {
      const replay = this.receipt(scopeId, runId, commandId, command, prior => fingerprint(prior) === fingerprint(command));
      if (replay) return replay;
      const current = await this.loadRun(scopeId, runId);
      if (!current || current.revision !== expectedRevision) throw new RunStoreError('RUN_STORE_CONFLICT');
      const due = (current.state.kind === 'parked' && current.state.deadline <= now) || current.progress.some(task => task.decision && task.decision.deadline <= now);
      if (!due) return Object.freeze({ commandId, command, snapshot: current });
    }
    return this.transaction(() => {
      const replay = this.receipt(scopeId, runId, commandId, command, prior => {
        try { return fingerprint(prior) === fingerprint(command); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
      }); if (replay) return replay;
      const row = this.db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
      if (!row || row.revision !== expectedRevision) throw new RunStoreError('RUN_STORE_CONFLICT');
      const current = decodeRunSnapshot(row.snapshot, scopeId, runId);
      if (current.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
      const binding = current.bindings.find(value => value.identity.taskId === parsed.taskId);
      const evidence = parsed.action === 'park-task' && binding ? Object.values(readEvaluationDigests(this.db, binding.identity)).filter((value): value is string => value !== undefined) : undefined;
      const snapshot = parsed.action === 'close' ? closeParkedRun(current, expectedRevision, now, timeoutMs)
        : parsed.action === 'resume' ? resumeParkedRun(current, expectedRevision, now, timeoutMs)
          : parsed.action === 'expire' ? expireParkedRun(current, expectedRevision, now, timeoutMs)
            : parsed.action === 'park-task' ? parkTaskAwaitingDecision(current, expectedRevision, parsed.taskId!, parsed.reason!, now, timeoutMs, undefined, evidence)
              : resolveTaskDecision(current, expectedRevision, parsed.taskId!, parsed.action, now, timeoutMs);
      // Runtime checks that found no transition write neither a revision nor a replay receipt on every poll.
      if (parsed.action === 'expire' && snapshot.revision === current.revision) return Object.freeze({ commandId, command, snapshot });
      const updated = this.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
        .run(snapshot.revision, JSON.stringify(snapshot), scopeId, runId, expectedRevision);
      if (updated.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      audit?.(new SqliteAuditStore(this.db), snapshot);
      return this.record({ commandId, command, snapshot });
    });
  }
  async cancelRun(input: RunCancellation): Promise<RunReceipt> {
    const parsed = runCancellationSchema.parse(input); const command = JSON.stringify({ action: 'cancel-run', ...parsed });
    const { scopeId, runId } = parsed;
    return this.transaction(() => {
      const replay = this.receipt(scopeId, runId, parsed.commandId, command); if (replay) return replay;
      const row = this.db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
      if (!row || row.revision !== parsed.expectedRevision) throw new RunStoreError('RUN_STORE_CONFLICT');
      const current = decodeRunSnapshot(row.snapshot, scopeId, runId);
      if (current.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
      propagateRunCancellation(this.db, current, parsed.actor);
      // Unlaunched attempts are prevented and already-exited unevaluated ones settled in the same transaction; running ones await delivery.
      const timing = { now: this.timing.now(), timeoutMs: this.timing.timeoutMs };
      const snapshot = settleRunCancellation(this.db, requestRunCancellation(current, parsed.expectedRevision, timing), timing);
      const updated = this.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
        .run(snapshot.revision, JSON.stringify(snapshot), scopeId, runId, parsed.expectedRevision);
      if (updated.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      return this.record({ commandId: parsed.commandId, command, snapshot });
    });
  }
  async createRun(input: RunCreate, workspace?: RunWorkspaceCustody): Promise<RunReceipt> {
    const parsed = runCreateSchema.parse(input); assertRunExecution(parsed.graph, parsed.execution); const command = JSON.stringify({ action: 'create-run', ...parsed });
    const { scopeId, runId } = parsed.identity;
    if (workspace && (workspace.scopeId !== scopeId || workspace.runId !== runId)) throw new RunStoreError('RUN_COMMAND_CONFLICT');
    return this.transaction(() => {
      const custody = new SqliteRunWorkspaceCustody(this.db);
      const replay = this.receipt(scopeId, runId, parsed.commandId, command);
      if (replay) { if (workspace && !custody.matchesWithin(workspace)) throw new RunStoreError('RUN_COMMAND_CONFLICT'); return replay; }
      const snapshot = createRun(parsed.identity, parsed.graph, parsed.now, parsed.execution, parsed.branch);
      new SqliteExecutionPools(this.db).require(parsed.policy.poolId);
      planSchedulingWave(snapshot.graph, { schemaVersion: 2, capacity: parsed.policy.capacity, ordering: parsed.policy.ordering, snapshot: { graphRevision: snapshot.graph.revision, now: parsed.now, progress: snapshot.progress } });
      const row = this.db.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING')
        .run(scopeId, runId, snapshot.revision, JSON.stringify(snapshot), JSON.stringify(parsed.policy));
      if (row.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      // Admission and automatic progression intent commit together. Migration never retroactively opts in old Runs.
      this.db.prepare('INSERT INTO run_execution_intents(scope_id,run_id,actor_id,issuer,subject,admitted_at,command_id) VALUES(?,?,?,?,?,?,?)')
        .run(scopeId, runId, parsed.actor.id, parsed.actor.issuer, parsed.actor.subject, parsed.now, parsed.commandId);
      // A pinned workspace is durable before any progression turn can observe the Run (never sampled from a moving HEAD later).
      if (workspace) custody.admitWithin(workspace);
      return this.record({ commandId: parsed.commandId, command, snapshot });
    });
  }
  async reserveRunTasks(input: RunReservation): Promise<RunReceipt> {
    const parsed = runReservationSchema.parse(input); const command = JSON.stringify({ action: 'reserve-run-tasks', ...parsed });
    const { scopeId, runId } = parsed;
    return this.transaction(() => {
      const replay = this.receipt(scopeId, runId, parsed.commandId, command); if (replay) return replay;
      const row = this.db.prepare('SELECT revision,snapshot,policy FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
      if (!row || row.revision !== parsed.expectedRevision) throw new RunStoreError('RUN_STORE_CONFLICT');
      const current = decodeRunSnapshot(row.snapshot, scopeId, runId);
      if (current.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
      // Cancellation closes never-reserved tasks, so report the cause before any capacity/order diagnosis.
      if (current.cancelRequested) throw new RunError('RUN_CANCEL_REQUESTED');
      if (current.state.kind !== 'running') throw new RunError('RUN_TASK_NOT_READY');
      let policy;
      try { policy = runExecutionPolicySchema.parse(JSON.parse(String(row.policy))); } catch { throw new RunStoreError('RUN_POOL_REQUIRED'); }
      let wave;
      try { wave = planSchedulingWave(current.graph, { excludedTaskIds: this.admission?.excluded(current, parsed.actor, parsed.now) ?? [], schemaVersion: 2, capacity: policy.capacity, ordering: policy.ordering, snapshot: { graphRevision: current.graph.revision, now: parsed.now, progress: current.progress } }); }
      catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
      if (parsed.identities.length > wave.selectedTaskIds.length || parsed.identities.some((id, i) => id.taskId !== wave.selectedTaskIds[i])) {
        throw new RunStoreError('RUN_CAPACITY_OR_ORDER', diagnoseReservationWave(wave, 'transaction-wave-mismatch', parsed.identities.length, policy.capacity));
      }
      // Validate every candidate before trimming; an invalid suffix must never disappear silently.
      const proposed = reserveRunTasks(current, parsed.expectedRevision, parsed.identities, parsed.now);
      // K5: a held pool admits no new reservation (precedence: cancel, wave, candidates, hold, capacity); nothing is written.
      const pools = new SqliteExecutionPools(this.db); pools.assertNotHeld(policy.poolId);
      const available = pools.available(policy.poolId, this.poolCeiling);
      if (available <= 0) throw new RunStoreError('RUN_POOL_FULL');
      const admitted = parsed.identities.slice(0, available);
      const snapshot = admitted.length === parsed.identities.length ? proposed
        : reserveRunTasks(current, parsed.expectedRevision, admitted, parsed.now);
      for (const identity of admitted) {
        const effort = readWorkerModelPin(current.execution.tasks.find(task => task.taskId === identity.taskId)?.profile.parameters)?.reasoningEffort;
        const attempt = createAttempt(identity, effort);
        const inserted = this.db.prepare('INSERT INTO attempts(scope_id,attempt_id,revision,snapshot) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
          .run(scopeId, identity.attemptId, attempt.revision, JSON.stringify(attempt));
        if (inserted.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      }
      const updated = this.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
        .run(snapshot.revision, JSON.stringify(snapshot), scopeId, runId, parsed.expectedRevision);
      if (updated.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      return this.record({ commandId: parsed.commandId, command, snapshot });
    });
  }
}
