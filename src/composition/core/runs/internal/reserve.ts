import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { ConfigLoadOptions } from '#platform/index.js';
import { openSqliteApprovalStore, openLocalIntegrityAuthority, openSqliteAttemptStore } from '#adapters/index.js';
import { assertApprovalPolicyCurrent, TaskApprovalAdmission, authenticate, PoolPolicyAuthorization, RunPolicyAuthorization, RunReservationApplication, composeRunAdmissionFilters, runReservationCommandSchema, type RunReservationCommand } from '#engine/index.js';
import { createInferenceRunAdmission, loadConfiguredInferenceProfile } from '#composition/core/inference-serving/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

/** Reserve the next scheduler-selected wave using the persisted Run policy and shared pool. */
export async function reserveConfiguredRunTasks(projectRoot: string, input: RunReservationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = runReservationCommandSchema.parse(input);
    const { config, layout, principal, path, document } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options);
    const verifier = { async verify() { return principal; } };
    const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
    const pinnedSource = { load: async () => assertApprovalPolicyCurrent(document, await source.load()) };
    const authorization = new RunPolicyAuthorization(pinnedSource);
    const poolAuthorization = new PoolPolicyAuthorization(pinnedSource);
    await authorization.authorize('reserve', command, await authenticate(verifier, undefined, command.scopeId));
    const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
    let approvalJournal: ReturnType<typeof openSqliteApprovalStore> | undefined;
    try {
      const filters = [];
      if ([...document.grants, ...document.restrictions].some(rule => rule.resource.kind === 'task')) {
        const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
        approvalJournal = openSqliteApprovalStore(await path(), config.storage.sqlite);
        filters.push(new TaskApprovalAdmission(document, principal, approvalJournal.store, integrity, config.approvals.requestTtlMs));
      }
      const inferenceProfile = await loadConfiguredInferenceProfile(projectRoot, options);
      if (inferenceProfile) filters.push(createInferenceRunAdmission(inferenceProfile));
      const admission = filters.length ? composeRunAdmissionFilters(...filters) : undefined;
      if (admission) store.setRunAdmissionFilter(admission);
      const application = new RunReservationApplication(store, verifier, authorization, poolAuthorization, { now: Date.now, attemptId: randomUUID }, admission);
      return Object.freeze({ schemaVersion: 1 as const, layout, reservation: await application.reserve(command) });
    } finally { approvalJournal?.close(); store.close(); }
  } catch (error) { throw queryFailure(error); }
}
