import { firstCommitTarget, FIRST_COMMIT_OPERATION } from '#adapters/index.js';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { PRINCIPAL_EFFECT_PRODUCER } from '#domain/index.js';
import { assertAuthorityWitness, EffectApplication, OperationApprovalBroker, OperationPolicyAuthorization } from '#engine/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel, LocalOsSessionAuthority,
  openLocalIntegrityAuthority, openSqliteAttemptStore, openSqliteApprovalStore } from '#adapters/index.js';
import { sha256, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
/** The confirmed preview uses the existing scope, operation approval, effect intent and durable settlement owners. */
export async function applyConfiguredFirstCommit(root: string, folder: string, scopeId: string,
  input: Readonly<{ message: string; digest: string; include?: readonly string[] }>, options: ConfigLoadOptions, signal?: AbortSignal) {
  await assertAuthorityWitness('coding.first-commit', localPrincipalChannel(), { attest: () => attestLocalInteractiveTerminal() });
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'write'), { config, layout, principal } = context;
  const target = await firstCommitTarget(folder, options.env ?? process.env, input, signal), descriptor = FIRST_COMMIT_OPERATION;
  const commandId = sha256(JSON.stringify(['coding.first-commit', target.identity(), scopeId, principal.issuer, principal.subject, input]));
  const command = { schemaVersion: 1 as const, commandId, scopeId, operation: descriptor.operation, target: { kind: target.kind, id: 'HEAD' },
    idempotencyKey: commandId, expectedVersion: input.digest, input };
  const clock = new SystemTrustedClock(), policy = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
  const sessions = await LocalOsSessionAuthority.create(principal.scopeIds, config.approvals.sessionTtlMs, clock);
  const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true), path = await context.path();
  const store = await openSqliteAttemptStore(path, config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
  const approvals = openSqliteApprovalStore(path, config.storage.sqlite);
  try {
    const broker = new OperationApprovalBroker(approvals.store, integrity, policy, clock,
      { requestTtlMs: config.approvals.requestTtlMs, defaultAdmitWithinMs: config.approvals.requestTtlMs });
    const app = new EffectApplication({ resolve: async ref => ref.id === descriptor.operation.id && ref.version === 1 ? descriptor : null },
      { resolve: kind => kind === target.kind ? target : null }, store, broker, sessions, new OperationPolicyAuthorization(policy), clock, { producer: PRINCIPAL_EFFECT_PRODUCER });
    let outcome = await app.submit('execute', command);
    if (outcome.status === 'approval-pending') {
      await configuredApproval(root, 'decide', { schemaVersion: 1, commandId: randomUUID(), scopeId, approvalId: outcome.approval.approvalId,
        expectedRevision: outcome.approval.revision, decision: 'allow', reason: input.digest, channel: 'local-terminal-card' }, options);
      outcome = await app.submit('execute', command);
    }
    return outcome;
  } finally { approvals.close(); store.close(); }
}
