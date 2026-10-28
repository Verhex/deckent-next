import { join } from 'node:path';
import { HOST_LIMITS_REGISTRY, inspectProductDirectory, jsonRecordDirectory, mapBounded, recordedProcessState, type ConfigLoadOptions } from '#platform/index.js';
import { DockerSupervisor, openLocalIntegrityAuthority, openSqliteAuditStore, openSqliteInventoryReader } from '#adapters/index.js';
import { AuditApplication, DISPATCH_PREPARATION_INSTANCE, DispatchInventoryPolicyAuthorization, NERVOUS_RULES_SEED, NervousApplication, SupervisorError, nervousExecutors, nervousRulePromoted, nervousStandingApproval,
  readDispatchLauncherEvidence, readDispatchPreparationRecord, type DispatchPreparationInstance, type NervousAttemptSignal, type NervousProposal, type ReconciliationRecoveryCommand } from '#engine/index.js';
import { reconcileAttemptFor } from './reconcile.js';
import { holdConfiguredRunForNervous } from './lifecycle.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Another instance's launcher is gone on ESRCH, a zombie or a pid reused since its recorded start (S6R-3 N7); any doubt reads alive (no fire). */
const launcherBasis = (instance: DispatchPreparationInstance): NervousAttemptSignal['launcher']['basis'] => instance.id === DISPATCH_PREPARATION_INSTANCE.id ? 'same-process'
  : instance.pid === process.pid || recordedProcessState(instance.pid, instance.startedAt) === 'gone' ? 'dead' : 'alive';
/**
 * S6R-2 shadow detector over the reconciliation loop (owner 2026-10-23 Q-R2; `runRuntime.nervous.mode`, default off: no rules load, nothing
 * runs). Per reconciliation page it re-reads the same inventory page read-only and samples each granted, unsettled dispatch (a fenced one only
 * re-applies its sealed case): Docker
 * activity (one extra inspect per such worker and poll), the launcher's preparation record or captured evidence; on each scope's first page
 * also the crash-loop and policy-turn audit feeds. In shadow its only write is the sealed `recovery-detection` record; `live` (S6R-3) adds the
 * broker's executors under the owner's standing policy grant. An unreadable registry throws at prepare.
 */
export function prepareConfiguredNervous(projectRoot: string, options: ConfigLoadOptions, mode: 'off' | 'shadow' | 'live', pageSize: number) {
  if (mode === 'off') return null;
  // The reconciliation loop pages serially, so one observe at a time holds the audit writer it opened.
  const ledger: { current: AuditApplication | null } = { current: null };
  // S6R-3 live: the broker's executors are the existing lost-dispatch chain and the s5b Nervous hold; each re-reads config, policy and ledger.
  const executors = mode === 'live' ? nervousExecutors({ recover: async (identity, step) => (await reconcileAttemptFor(projectRoot, identity, options, step)).reconciliation,
    hold: command => holdConfiguredRunForNervous(projectRoot, command, options) }) : {};
  const app = new NervousApplication({ audit: { record: event => ledger.current!.record(event), load: (scopeId, eventId) => ledger.current!.load(scopeId, eventId) },
    now: Date.now }, NERVOUS_RULES_SEED, { live: mode === 'live', approval: null, executors });
  return Object.freeze({ async observe(command: ReconciliationRecoveryCommand) { try {
    const c = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'read'), path = await c.path();
    await new DispatchInventoryPolicyAuthorization({ async load() { return c.document; } }).authorize(command.scopeId, c.principal);
    const crashes = await inspectProductDirectory(c.layout, 'crashes').catch(() => null), reader = await openSqliteInventoryReader(path, { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
    let signals: NervousAttemptSignal[];
    try {
      const page = await reader.listDispatches({ schemaVersion: 1, scopeId: command.scopeId, after: command.after, limit: pageSize });
      signals = (await mapBounded(page.entries.filter(entry => entry.launch === 'granted' && !entry.terminal), HOST_LIMITS_REGISTRY.observationConcurrency, async (entry): Promise<NervousAttemptSignal | null> => {
        const record = await reader.loadBoundDispatch(entry.identity);
        if (!record) return null;
        const activity = await DockerSupervisor.restoreProfile(record.profile).then(supervisor => supervisor.inspectActivity(record.request)).then(value => value.state,
          (error: unknown) => error instanceof SupervisorError && error.code === 'SUPERVISOR_CONTROL_FAILED' ? 'control-failed' as const : 'unknown' as const);
        const evidence = crashes ? await readDispatchLauncherEvidence(jsonRecordDirectory(join(crashes, 'dispatch-launcher')), entry.identity).catch(() => 'unreadable' as const) : null;
        const prepared = !evidence && crashes ? await readDispatchPreparationRecord(jsonRecordDirectory(join(crashes, 'dispatch-preparation')), entry.identity).catch(() => 'unreadable' as const) : null;
        const found = evidence === 'unreadable' || evidence?.launcher.kind === 'unreadable' ? 'unreadable' : evidence ? evidence.launcher : prepared;
        const launcher = found === 'unreadable' ? { basis: 'unreadable' as const, phase: null } : found ? { basis: launcherBasis(found.instance), phase: found.phase } : { basis: 'none' as const, phase: null };
        return { identity: entry.identity, activity, launcher, containerRecorded: record.containerId !== undefined, workerRecorded: record.worker !== undefined, fenced: entry.fenced === true };
      })).filter((signal): signal is NervousAttemptSignal => signal !== null);
    } finally { reader.close(); }
    const store = await openSqliteAuditStore(path, c.config.storage.sqlite);
    try {
      const audit = ledger.current = new AuditApplication(store, await openLocalIntegrityAuthority(c.layout, c.config.approvals.keyFile, true));
      const context = { owner: { issuer: c.principal.issuer, subject: c.principal.subject }, policyRevision: c.document.revision,
        approval: (proposal: NervousProposal) => nervousStandingApproval(c.document, c.principal, proposal, Date.now()),
        promoted: (ruleId: string, version: number) => nervousRulePromoted(c.document, c.principal, command.scopeId, ruleId, version) };
      await app.observeAttempts(command.scopeId, signals, context);
      if (command.after === null) for (const kind of ['dispatch-preparation-aborted', 'policy-turn', 'beuser-target-refusal'] as const) {
        await app.observeFeed(command.scopeId, kind, audit.listKind(command.scopeId, kind, app.feedCursor(command.scopeId, kind), app.rules.tracking.feedPageSize), context);
      }
    } finally { ledger.current = null; store.close(); }
  } catch (error) { throw queryFailure(error); } } });
}
