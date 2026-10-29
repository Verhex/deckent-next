import { recordedExecutionSupervisor } from '#composition/core/supervisors/index.js';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { inspectProductDirectory, jsonRecordDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { openLocalIntegrityAuthority, FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { AuditApplication, LostDispatchApplication, dispatchFenceReceiptId, removeDispatchLaunchRecord, authenticate, DispatchApplication, DispatchPolicyAuthorization, DispatchError, type DispatchStore, type RunBoundDispatchStore, type DispatchAuthorization, type DispatchIdentityAuthorization } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
/** Reconcile a recorded attempt; callers cannot supply executable, workspace or supervisor options.
 * Observation may settle an exited process, never launch/retry it or accept a Task's business result.
 */
export const reconcileConfiguredAttempt = (projectRoot: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) => reconcileAttemptFor(projectRoot, input, options, null);
/** S6R-3 `step` (the Nervous broker's executors only; no public entry passes it): write the first fence (MARK-LOST-ATOMIC) after one fresh
 * observation that retains a running incarnation; `stop` then issues the authorized cancellation. A fenced exit settles nothing (stop issued, proof pending). */
export async function reconcileAttemptFor(projectRoot: string, input: AttemptIdentity, options: ConfigLoadOptions, step: 'fence' | 'stop' | null) {
  try {
    const identity = attemptIdentitySchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, identity.scopeId, options, 'write');
    const os = userInfo(); const verifier = { async verify() { return principal; } };
    const authorization: DispatchAuthorization & DispatchIdentityAuthorization = new DispatchPolicyAuthorization(createLayoutPolicySource(layout, os.uid, config.inspection.policyMaxBytes));
    const actor = await authenticate(verifier, undefined, identity.scopeId);
    await authorization.authorizeIdentity('reconcile', identity, actor);
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');

    try {
      const dispatchStore: DispatchStore & RunBoundDispatchStore = store;
      const recorded = await dispatchStore.loadBoundDispatch(identity);
      if (!recorded) throw new DispatchError('DISPATCH_NOT_ADMITTED');
      const run = await store.loadRun(identity.scopeId, identity.runId), attempt = await store.load(identity.scopeId, identity.attemptId);
      if (!run || !attempt) throw new DispatchError('DISPATCH_NOT_ADMITTED');
      const artifactRoot = await inspectProductDirectory(layout, 'artifacts');
      const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: config.artifacts.maxBytes });
      const supervisor = recordedExecutionSupervisor(recorded, { config, layout, store, artifacts });
      const app = new DispatchApplication(dispatchStore, supervisor, verifier, authorization, principal.id, artifacts);
      const fenced = await store.loadRunReceipt(identity.scopeId, dispatchFenceReceiptId(identity, recorded.owner)), settled = step && !fenced ? await app.reconcile(recorded.request) : null;
      if (settled ? settled.kind === 'unresolved' : fenced) {
        const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
        const recovery = new LostDispatchApplication(store, verifier, authorization, {
          observe: record => supervisor.observe(record.request),
          termination: record => supervisor.observeTermination?.(record.request, record.worker!) ?? Promise.resolve(null),
          createdAbsence: record => supervisor.observeCreatedAbsence?.(record.request, record.containerId!) ?? Promise.resolve(null),
        }, target => new AuditApplication(target, integrity), document.revision, Date.now);
        const command = { schemaVersion: 1, identity, expectedRunRevision: run.revision, expectedAttemptRevision: attempt.revision };
        if (step === 'stop') {
          await recovery.fence(command); await app.cancel(recorded.request).catch(error => { if (!(error instanceof DispatchError && error.code === 'DISPATCH_FENCED')) throw error; });
          // S6R-4 (lead on s6r3 Q3): a never-started container (only its created id retained) is removed by that id, so its absence can prove the release.
          const lost = await dispatchStore.loadBoundDispatch(identity);
          if (lost && !lost.worker && lost.containerId) await supervisor.removeCreatedContainer?.(lost.request, lost.containerId);
        }
        const recovered = await recovery.recover(command), kept = await dispatchStore.loadBoundDispatch(identity), crashes = await inspectProductDirectory(layout, 'crashes').catch(() => null);
        // The case ends in a release: the launcher's records of this Attempt are pruned (its sealed detection keeps the evidence summary).
        if (recovered.decision.kind === 'release' && crashes) await Promise.all(['dispatch-preparation', 'dispatch-launcher'].map(name => removeDispatchLaunchRecord(jsonRecordDirectory(join(crashes, name)), identity)));
        return Object.freeze({ schemaVersion: 1 as const, layout, reconciliation: Object.freeze({ identity, status: 'unresolved' as const, terminal: recorded.terminal, outputRecorded: !!recorded.output, disposition: recovered.decision,
          ...(step ? { retained: kept?.worker ? 'incarnation' as const : kept?.containerId ? 'container' as const : 'none' as const } : {}) }) });
      }
      const result = settled ?? await app.reconcile(recorded.request);
      // Durable cancellation intent plus settled terminal evidence closes the bound task; no launch, retry or acceptance.
      const settlement = result.kind === 'unresolved' ? undefined : await store.settleCancelledAttempt(identity);
      return Object.freeze({ schemaVersion: 1 as const, layout, reconciliation: Object.freeze({
        identity, status: result.kind, terminal: result.record.terminal, outputRecorded: !!result.record.output,
        ...(settlement ? { settlement } : {}),
      }) });
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
