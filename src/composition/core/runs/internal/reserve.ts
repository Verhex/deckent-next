import { randomUUID } from 'node:crypto';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { openSqliteApprovalStore, openLocalIntegrityAuthority, openSqliteAttemptStore, selectWorkTarget } from '#adapters/index.js';
import { assertApprovalPolicyCurrent, TaskApprovalAdmission, authenticate, policyGatesTaskAdmission, executionResourceAuthorization, RunPolicyAuthorization, RunReservationApplication, runReservationCommandSchema, type RunReservationCommand } from '#engine/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
export async function reserveConfiguredRunTasks(projectRoot: string, input: RunReservationCommand, options: ConfigLoadOptions = {}, attemptId: (taskId: string) => string = () => randomUUID()) {
  try {
    const command = runReservationCommandSchema.parse(input);
    const { config, layout, principal, path, document } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write');
    const verifier = { async verify() { return principal; } };
    const source = contextPolicySource({ layout, config });
    const pinnedSource = contextPolicySource({ layout, config }, async () => assertApprovalPolicyCurrent(document, await source.load()));
    const authorization = new RunPolicyAuthorization(pinnedSource);
    const poolAuthorization = executionResourceAuthorization(pinnedSource, selectWorkTarget(config.execution)?.id ?? null);
    await authorization.authorize('reserve', command, await authenticate(verifier, undefined, command.scopeId));
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
    store.setExecutionPoolCeiling(config.max_workers);
    let approvalJournal: ReturnType<typeof openSqliteApprovalStore> | undefined;
    try {
      let admission: TaskApprovalAdmission | undefined;
      if (policyGatesTaskAdmission(document)) {
        const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
        approvalJournal = openSqliteApprovalStore(await path(), config.storage.sqlite);
        admission = new TaskApprovalAdmission(document, principal, approvalJournal.store, integrity, config.approvals.requestTtlMs, config.approvals.requestTtlMs);
        store.setRunAdmissionFilter(admission);
      }
      const clock = new SystemTrustedClock();
      const application = new RunReservationApplication(store, verifier, authorization, poolAuthorization,
        { now: () => clock.sample().wallMs, attemptId }, admission);
      return Object.freeze({ schemaVersion: 1 as const, layout, reservation: await application.reserve(command) });
    } finally { approvalJournal?.close(); store.close(); }
  } catch (error) { throw queryFailure(error); }
}
