import { readRunResourceCapacity } from '#adapters/core/sqlite-model-invocation/index.js';
import { readEnvironmentProbeHolds, commitEnvironmentProbeSettlement, writeEnvironmentProbeCustody, releaseEnvironmentProbeCustody, type EnvironmentProbeHold, quotaHeldTasks, readAcceptedOperationSettlements, openLedgerStore, sqliteFailure, ledgerTransaction, decodeStored, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { loadQuotaReleasePools, releaseQuota } from '#adapters/core/quota-control-store/index.js';
import { readDispatchFence, readTaskHandoffEvaluation, readRunBoundDispatch, readRunBoundTask, readRunEvaluationPrincipal, loadCancellationDispatch, settleAttemptCancellation, SqliteRunWorkspaceCustody, SqliteRunJournal } from '#adapters/core/run-store/index.js';
import { SqliteDeliveryJournal } from './delivery.js';
import { SqliteTargetQueue } from '#adapters/core/target-queue-store/index.js';
import { SqliteAdoptionJournal } from './adoption.js';
import { SqliteEffectJournal } from '#adapters/core/sqlite-effect-store/index.js';
import { SqliteWorkerEventLogs } from './worker-events.js';
import { type IntegrationIntent, type IntegrationDeliveryCommand, type IntegrationDeliveryIntent, type IntegrationQuery, type IntegrationAdoptionIntent, type AdoptionClaimObservation, type ProgressionQuery, type RunStore, type RunCancellation, type ExecutionPool, type RunCreate, type RunReservation, type RunProjection, type ServiceShutdownStore, type TaskEvaluationCommit, type TaskEvaluationStore, type PoolHoldStore, type PoolCapacityStore, type CancellationDeliveryClaim, type CancellationDeliveryOutcome, type CancellationDeliveryStore, type DispatchClaim, type DispatchAdmission, type SupervisorProfileValidator, type LaunchRequest, type DispatchTerminal, type DispatchStore, type RunBoundDispatchStore, type DispatchInventoryQuery, type DispatchInventoryStore, AttemptStoreError, dispatchRecordSchema, DispatchError, attemptDispatchWriteToken, readSealedWorkerEvents, type AttemptCommit, type AttemptReceipt, type AttemptStore } from '#engine/index.js';
import { SqliteIntegrationJournal, readIntegration } from './integration.js';
import { SqliteRunProgression } from './progression.js';
import { SqliteCancellationDeliveryJournal } from './cancellation-delivery.js';
import { SqliteCancellationRecoveryQuery } from './cancellation-recovery.js';
import { SqliteServiceShutdownJournal } from '#adapters/core/service-shutdown-store/index.js';
import { SqlitePoolCapacityJournal } from './pool-capacity.js';
import { SqlitePoolHoldJournal } from './pool-holds.js';
import type { ArtifactReceipt } from '#capabilities/index.js';
import { SqliteDispatchJournal } from './dispatch.js';
import type { DatabaseSync } from 'node:sqlite';
import { attemptSnapshotSchema, sameAttemptIdentity, verifiedPrincipalSchema, type AttemptIdentity, type VerifiedPrincipal } from '#domain/index.js';
/** Dedicated execution database. Path ownership/permissions are established by composition, not this adapter. */
const corrupt = () => new AttemptStoreError('ATTEMPT_STORE_CORRUPT');
export class SqliteAttemptStore implements AttemptStore, DispatchStore, RunBoundDispatchStore, DispatchInventoryStore, RunStore, CancellationDeliveryStore, ServiceShutdownStore, TaskEvaluationStore, PoolHoldStore, PoolCapacityStore {
  private readonly db: DatabaseSync;
  private admission: import('#engine/index.js').RunAdmissionFilter | undefined;
  private poolCeiling: number | undefined;
  /** Trusted composition only; the current installation ceiling is checked with shared occupancy in the reservation transaction. */
  setExecutionPoolCeiling(value: number | 'auto') {
    if (value !== 'auto' && (!Number.isSafeInteger(value) || value <= 0)) throw new AttemptStoreError('ATTEMPT_STORE_OPTIONS');
    this.poolCeiling = value === 'auto' ? undefined : value;
  }
  setRunAdmissionFilter(admission: import('#engine/index.js').RunAdmissionFilter) { this.admission = admission; }
  async loadTargetQueueVerification(scopeId: string, runId: string) { return new SqliteTargetQueue(this.db).forVerification(scopeId, runId); }
  constructor(path: string, options: SqliteLedgerOptions, private readonly lifecycleTiming: { now: () => number; timeoutMs: number }, migration: 'allow' | 'forbid' = 'allow', private readonly profiles?: SupervisorProfileValidator) {
    this.db = openLedgerStore(path, options, 'write', migration, this.profiles);
  }
  async loadQuotaReleasePools(write: Omit<import('#engine/index.js').QuotaReleaseWrite, 'authorizedPoolIds'>) { return loadQuotaReleasePools(this.db, write); }
  async releaseQuota(write: import('#engine/index.js').QuotaReleaseWrite, audit: (store: import('#engine/index.js').AuditStore, released: number, poolIds: readonly string[]) => void) { return releaseQuota(this.db, write, audit); }
  async quotaHeldTasks(run: import('#domain/index.js').RunSnapshot, now: number) { return quotaHeldTasks(this.db, run, now); }
  async loadTaskHandoffEvaluation(identity: AttemptIdentity) { return readTaskHandoffEvaluation(this.db, identity); }
  async loadBoundDispatch(identity: AttemptIdentity) {
    try { return readRunBoundDispatch(this.db, identity).dispatch; } catch (error) { throw sqliteFailure(error); }
  }
  async loadBoundTask(identity: AttemptIdentity) {
    try { return readRunBoundTask(this.db, identity); } catch (error) { throw sqliteFailure(error); }
  }
  /** Settles a cancel-requested attempt from durable intent and recorded terminal evidence; idempotent, never launches or retries. */
  async settleCancelledAttempt(identity: AttemptIdentity) {
    return ledgerTransaction(this.db, () => settleAttemptCancellation(this.db, identity, { now: this.lifecycleTiming.now(), timeoutMs: this.lifecycleTiming.timeoutMs }));
  }
  async loadCancellationDispatch(identity: AttemptIdentity) {
    try { return loadCancellationDispatch(this.db, identity); } catch (error) { throw sqliteFailure(error); }
  }
  async claimCancellationDelivery(input: CancellationDeliveryClaim) { return new SqliteCancellationDeliveryJournal(this.db).claimCancellationDelivery(input); }
  async finishCancellationDelivery(input: CancellationDeliveryClaim & { readonly outcome: CancellationDeliveryOutcome }) {
    return new SqliteCancellationDeliveryJournal(this.db).finishCancellationDelivery(input);
  }
  async discoverCancellationRecovery(input: import('#engine/index.js').CancellationRecoveryQuery) {
    return new SqliteCancellationRecoveryQuery(this.db).discoverCancellationRecovery(input);
  }
  async loadRunWorkspaceCustody(scopeId: string, runId: string) { return new SqliteRunWorkspaceCustody(this.db).loadRunWorkspaceCustody(scopeId, runId); }
  async admitServiceShutdown(admission: import('#engine/index.js').ShutdownAdmission) { return new SqliteServiceShutdownJournal(this.db).admitServiceShutdown(admission); }
  async readServiceShutdown(key: import('#engine/index.js').ServiceShutdownKey) { return new SqliteServiceShutdownJournal(this.db).readServiceShutdown(key); }
  async retainServiceShutdownOutcome(outcome: import('#engine/index.js').ShutdownOutcome) { return new SqliteServiceShutdownJournal(this.db).retainServiceShutdownOutcome(outcome); }
  async resolveRunWorkspaceCustody(input: import('#engine/index.js').RunWorkspaceCustody) { return new SqliteRunWorkspaceCustody(this.db).resolveRunWorkspaceCustody(input); }
  async listRunProgression(query: ProgressionQuery) { return new SqliteRunProgression(this.db).listRunProgression(query); }
  async listForeignProgressionScopes(query: Parameters<SqliteRunProgression['listForeignProgressionScopes']>[0]) { return new SqliteRunProgression(this.db).listForeignProgressionScopes(query); }
  async listRunLifecycleDue(query: ProgressionQuery & { readonly now: number }) { return new SqliteRunProgression(this.db).listRunLifecycleDue(query); }
  async hasTaskEvaluation(identity: unknown, revision: number) { return new SqliteRunProgression(this.db).hasTaskEvaluation(identity, revision); }
  async loadRunReceipt(scopeId: string, commandId: string) { return new SqliteRunJournal(this.db, undefined, this.lifecycleTiming).loadRunReceipt(scopeId, commandId); }
  async retainDispatchContainer(...args: Parameters<SqliteDispatchJournal['retainDispatchContainer']>) { return new SqliteDispatchJournal(this.db).retainDispatchContainer(...args); }
  async retainDispatchWorker(...args: Parameters<SqliteDispatchJournal['retainDispatchWorker']>) { return new SqliteDispatchJournal(this.db).retainDispatchWorker(...args); }
  async releaseLostDispatch(...args: Parameters<SqliteRunJournal['releaseLostDispatch']>) { return new SqliteRunJournal(this.db, undefined, this.lifecycleTiming).releaseLostDispatch(...args); }
  async fenceLostDispatch(...args: Parameters<import('#engine/index.js').LostDispatchStore['fenceLostDispatch']>) { return new SqliteRunJournal(this.db, undefined, this.lifecycleTiming).fenceLostDispatch(...args); }
  async cancelRun(input: RunCancellation) { return new SqliteRunJournal(this.db, undefined, this.lifecycleTiming).cancelRun(input); }
  async commitRunLifecycle(input: import('#engine/index.js').RunLifecycleWrite,
    audit?: (store: import('#engine/index.js').AuditStore, snapshot: import('#domain/index.js').RunSnapshot) => void) {
    return new SqliteRunJournal(this.db, undefined, this.lifecycleTiming).commitRunLifecycle(input, audit);
  }
  async createExecutionPool(input: ExecutionPool) { return new SqliteRunJournal(this.db, undefined, this.lifecycleTiming).createExecutionPool(input); }
  // K5 typed pool hold (ledger v44): status read, the one hold/resume writer, and a refusal's audit event.
  readPoolCapacity(poolId: string) { return new SqlitePoolCapacityJournal(this.db).readPoolCapacity(poolId); }
  applyPoolCapacity(...args: Parameters<PoolCapacityStore['applyPoolCapacity']>) { return new SqlitePoolCapacityJournal(this.db).applyPoolCapacity(...args); }
  readPoolHold(poolId: string) { return new SqlitePoolHoldJournal(this.db).readPoolHold(poolId); }
  applyPoolHold(...args: Parameters<PoolHoldStore['applyPoolHold']>) { return new SqlitePoolHoldJournal(this.db).applyPoolHold(...args); }
  recordPoolHoldRefusal(audit: Parameters<PoolHoldStore['recordPoolHoldRefusal']>[0]) { return new SqlitePoolHoldJournal(this.db).recordPoolHoldRefusal(audit); }
  async environmentProbeHolds(filter?: Readonly<{ scopeId: string; runId: string }>) { return readEnvironmentProbeHolds(this.db, filter); }
  async settleEnvironmentProbe(hold: EnvironmentProbeHold) { return commitEnvironmentProbeSettlement(this.db, hold, this.lifecycleTiming); }
  async holdEnvironmentProbes(identity: unknown, probes: readonly string[]) { writeEnvironmentProbeCustody(this.db, identity, probes); }
  async releaseEnvironmentProbes(identity: unknown) { return releaseEnvironmentProbeCustody(this.db, identity, this.lifecycleTiming); }
  async projectRunAttempt(input: RunProjection) { return new SqliteRunJournal(this.db, undefined, this.lifecycleTiming).projectRunAttempt(input); }
  async commitTaskEvaluation(input: TaskEvaluationCommit) { return new SqliteRunJournal(this.db, undefined, this.lifecycleTiming).commitTaskEvaluation(input); }
  async loadAcceptedOperationSettlements(run: import('#domain/index.js').RunSnapshot) { return readAcceptedOperationSettlements(this.db, run); }
  async loadRunEvaluationPrincipal(identity: AttemptIdentity) { return readRunEvaluationPrincipal(this.db, identity); }
  async loadRun(scopeId: string, runId: string) { return new SqliteRunJournal(this.db, undefined, this.lifecycleTiming).loadRun(scopeId, runId); }
  async loadRunExecutionPolicy(scopeId: string, runId: string) { return new SqliteRunJournal(this.db, undefined, this.lifecycleTiming).loadRunExecutionPolicy(scopeId, runId); }
  async loadRunResourceCapacity(run: import('#domain/index.js').RunSnapshot) { return readRunResourceCapacity(this.db, run); }
  async createRun(input: RunCreate, workspace?: import('#engine/index.js').RunWorkspaceCustody, assertAuthority?: () => void, resources?: readonly import('#engine/index.js').RunCapacityBinding[]) { return new SqliteRunJournal(this.db, undefined, this.lifecycleTiming).createRun(input, workspace, assertAuthority, resources); }
  async reserveRunTasks(input: RunReservation) { return new SqliteRunJournal(this.db, this.admission, this.lifecycleTiming, this.poolCeiling).reserveRunTasks(input); }
  async listDispatches(query: DispatchInventoryQuery) { return new SqliteDispatchJournal(this.db).listDispatches(query); }
  async requestDispatchCancellation(request: DispatchClaim['request'], principal: VerifiedPrincipal) { return new SqliteDispatchJournal(this.db).requestDispatchCancellation(request, principal); }
  async retainDispatchPatch(claim: DispatchClaim, receipt: ArtifactReceipt) { return new SqliteDispatchJournal(this.db).retainDispatchPatch(claim, receipt); }
  async retainDispatchOutput(claim: DispatchClaim, receipt: ArtifactReceipt) { return new SqliteDispatchJournal(this.db).retainDispatchOutput(claim, receipt); }
  async readDispatch(request: DispatchClaim['request']) { return new SqliteDispatchJournal(this.db).readDispatch(request); }
  async claimDispatch(claim: DispatchAdmission) { return new SqliteDispatchJournal(this.db, this.profiles).claimDispatch(claim, this.lifecycleTiming.now()); }
  async grantLaunch(input: LaunchRequest) { return new SqliteDispatchJournal(this.db).grantLaunch(input, { now: this.lifecycleTiming.now(), timeoutMs: this.lifecycleTiming.timeoutMs }); }
  async finishDispatch(claim: DispatchClaim, terminal: DispatchTerminal) { return new SqliteDispatchJournal(this.db).finishDispatch(claim, terminal, { now: this.lifecycleTiming.now(), timeoutMs: this.lifecycleTiming.timeoutMs }); }
  async claimIntegration(intent: IntegrationIntent) { return new SqliteIntegrationJournal(this.db).claimIntegration(intent); }
  async finishIntegration(intent: IntegrationIntent, receipt: ArtifactReceipt) { return new SqliteIntegrationJournal(this.db).finishIntegration(intent, receipt); }
  async loadIntegration(query: IntegrationQuery) { return readIntegration(this.db, query); }
  async loadDelivery(command: IntegrationDeliveryCommand) { return new SqliteDeliveryJournal(this.db).loadDelivery(command); }
  async claimDelivery(intent: IntegrationDeliveryIntent) { return new SqliteDeliveryJournal(this.db).claimDelivery(intent); }
  async finishDelivery(intent: IntegrationDeliveryIntent) { return new SqliteDeliveryJournal(this.db).finishDelivery(intent); }
  async findDelivery(scopeId: string, commandId: string) { return new SqliteDeliveryJournal(this.db).findDelivery(scopeId, commandId); }
  async loadAdoption(scopeId: string, commandId: string) { return new SqliteAdoptionJournal(this.db).loadAdoption(scopeId, commandId); }
  async claimAdoption(intent: IntegrationAdoptionIntent, observed: AdoptionClaimObservation) { return new SqliteAdoptionJournal(this.db).claimAdoption(intent, observed); }
  async assertAdoptionFence(targetRef: string, observed: AdoptionClaimObservation) { return new SqliteAdoptionJournal(this.db).assertAdoptionFence(targetRef, observed); }
  async finishAdoption(intent: IntegrationAdoptionIntent) { return new SqliteAdoptionJournal(this.db).finishAdoption(intent); }
  async releaseAdoption(intent: IntegrationAdoptionIntent) { return new SqliteAdoptionJournal(this.db).releaseAdoption(intent); }
  async saveWorkerEventLog(record: import('#engine/index.js').WorkerEventLog) { return new SqliteWorkerEventLogs(this.db).saveWorkerEventLog(record); }
  async loadWorkerEventLog(scopeId: string, attemptId: string) { return new SqliteWorkerEventLogs(this.db).loadWorkerEventLog(scopeId, attemptId); }
  /** EXEC-RELEASE (Sol ER-R1): the sealed stream itself, verified like every reader does: full attempt identity, artifact read by receipt
   * (size + digest) and event schema; null without a sealed log, `WORKER_OBSERVATION_INVALID` for anything else. */
  async loadSealedWorkerEvents(identity: AttemptIdentity, artifacts: Pick<import('#capabilities/index.js').ArtifactStore, 'read'>) { return readSealedWorkerEvents(this, artifacts, identity); }
  async loadEffect(scopeId: string, commandId: string) { return new SqliteEffectJournal(this.db).loadEffect(scopeId, commandId); }
  async loadEffectCompensation(scopeId: string, commandId: string) { return new SqliteEffectJournal(this.db).loadEffectCompensation(scopeId, commandId); }
  async claimEffect(intent: import('#domain/index.js').EffectIntent) { return new SqliteEffectJournal(this.db).claimEffect(intent); }
  async saveEffect(previous: import('#domain/index.js').EffectRecord, next: import('#domain/index.js').EffectRecord) { return new SqliteEffectJournal(this.db).saveEffect(previous, next); }
  close(): void { this.db.close(); }
  async load(scopeId: string, attemptId: string) {
    let row;
    try { row = this.db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId); }
    catch (error) { throw sqliteFailure(error); }
    if (!row) return null;
    const snapshot = this.decode(row.snapshot);
    if (snapshot.identity.scopeId !== scopeId || snapshot.identity.attemptId !== attemptId) throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT');
    return snapshot;
  }
  async receipt(scopeId: string, commandId: string): Promise<AttemptReceipt | null> {
    try { return this.readReceipt(scopeId, commandId); } catch (error) { throw sqliteFailure(error); }
  }
  private decode(value: unknown) { return decodeStored(attemptSnapshotSchema, value, corrupt); }
  private readReceipt(scopeId: string, commandId: string): AttemptReceipt | null {
    const row = this.db.prepare('SELECT command, snapshot FROM attempt_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null;
    const snapshot = this.decode(row.snapshot);
    if (snapshot.identity.scopeId !== scopeId || typeof row.command !== 'string') throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT');
    return Object.freeze({ commandId, command: row.command, snapshot });
  }
  async commit(input: AttemptCommit): Promise<AttemptReceipt> {
    const snapshot = attemptSnapshotSchema.parse(input.snapshot), { scopeId, attemptId } = snapshot.identity;
    const cancellationActor = input.cancellationActor === undefined ? undefined : verifiedPrincipalSchema.parse(input.cancellationActor);
    if (cancellationActor && (!cancellationActor.scopeIds.includes(scopeId) || !snapshot.cancelRequested || input.expectedRevision === null)) throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT');
    return ledgerTransaction(this.db, () => {
      const dispatch = this.db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId);
      if (dispatch) {
        if (cancellationActor) {
          decodeStored(dispatchRecordSchema, dispatch.record, corrupt, record => sameAttemptIdentity(record.request.identity, snapshot.identity));
        }
        const token = attemptDispatchWriteToken(dispatch.record, snapshot.identity, input.commandId);
        const fence = readDispatchFence(this.db, token.record);
        if (fence && !cancellationActor) throw new DispatchError('DISPATCH_FENCED');
      }
      const existing = this.readReceipt(scopeId, input.commandId);
      if (existing) {
        if (existing.command !== input.command) throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT');
        return existing;
      }
      const encoded = JSON.stringify(snapshot);
      if (input.expectedRevision !== null) {
        const currentRow = this.db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId);
        if (!currentRow) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
        const current = this.decode(currentRow.snapshot);
        if (!sameAttemptIdentity(current.identity, snapshot.identity) ||
          (snapshot.revision === input.expectedRevision && JSON.stringify(current) !== encoded)) throw new AttemptStoreError('ATTEMPT_STORE_CONFLICT');
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
      if (cancellationActor) {
        const dispatchRow = this.db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId);
        if (dispatchRow) {
          const dispatch = decodeStored(dispatchRecordSchema, dispatchRow.record, corrupt, record => sameAttemptIdentity(record.request.identity, snapshot.identity));
          const actor = { id: cancellationActor.id, issuer: cancellationActor.issuer, subject: cancellationActor.subject };
          if (dispatch.cancellation && JSON.stringify(dispatch.cancellation) !== JSON.stringify(actor)) throw new AttemptStoreError('ATTEMPT_COMMAND_CONFLICT');
          const attributed = dispatchRecordSchema.parse({ ...dispatch, cancellation: actor });
          this.db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?')
            .run(JSON.stringify(attributed), scopeId, attemptId);
        }
      }
      this.db.prepare('INSERT INTO attempt_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,?)')
        .run(scopeId, input.commandId, input.command, encoded);
      return Object.freeze({ commandId: input.commandId, command: input.command, snapshot });
    });
  }
}
