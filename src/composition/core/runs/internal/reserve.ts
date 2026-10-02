import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteApprovalStore, openLocalIntegrityAuthority, openSqliteAttemptStore, selectWorkTarget } from '#adapters/index.js';
import { assertApprovalPolicyCurrent, TaskApprovalAdmission, authenticate, policyGatesTaskAdmission, executionResourceAuthorization, RunPolicyAuthorization, RunReservationApplication, runReservationCommandSchema, type RunReservationCommand } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

/** Reserve the next scheduler-selected wave using the persisted Run policy and shared pool. */
export async function reserveConfiguredRunTasks(projectRoot: string, input: RunReservationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = runReservationCommandSchema.parse(input);
    const { config, layout, principal, path, document } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write');
    const verifier = { async verify() { return principal; } };
    const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
    const pinnedSource = { load: async () => assertApprovalPolicyCurrent(document, await source.load()) };
    const authorization = new RunPolicyAuthorization(pinnedSource);
    const poolAuthorization = executionResourceAuthorization(pinnedSource, selectWorkTarget(config.execution)?.id ?? null);
    await authorization.authorize('reserve', command, await authenticate(verifier, undefined, command.scopeId));
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');

    let approvalJournal: ReturnType<typeof openSqliteApprovalStore> | undefined;
    try {
      let admission: TaskApprovalAdmission | undefined;
      // A task rule may come from an explicit grant/restriction or from a role a binding grants to this principal (H34 S2 follow-up).
      if (policyGatesTaskAdmission(document)) {
        const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
        approvalJournal = openSqliteApprovalStore(await path(), config.storage.sqlite);
        admission = new TaskApprovalAdmission(document, principal, approvalJournal.store, integrity, config.approvals.requestTtlMs);
        store.setRunAdmissionFilter(admission);
      }
      // Approval records carry trusted-clock times; reservation reads the same floored clock (I40).
      const clock = new SystemTrustedClock();
      const application = new RunReservationApplication(store, verifier, authorization, poolAuthorization,
        { now: () => clock.sample().wallMs, attemptId: randomUUID }, admission);
      return Object.freeze({ schemaVersion: 1 as const, layout, reservation: await application.reserve(command) });
    } finally { approvalJournal?.close(); store.close(); }
  } catch (error) { throw queryFailure(error); }
}
