import { resolveLocale, type ConfigLoadOptions } from '#platform/index.js';
import { attestLocalInteractiveTerminal, localPrincipalPeer, openSqliteApprovalStore, openLocalIntegrityAuthority, openSqliteAttemptStore, openSqliteInventoryReader } from '#adapters/index.js';
import { RunDecisionApprovalBroker, AuditApplication, DispatchPolicyAuthorization, RunLifecycleApplication, runLifecycleCommandSchema, runProgressionParkCommandSchema, RunPolicyAuthorization, projectRunView, runQuerySchema, type RunQuery } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
export const applyConfiguredRunLifecycle = (root: string, command: unknown, options: ConfigLoadOptions = {}) => applyLifecycle(root, command, options, false);
export const parkConfiguredRunProgression = (root: string, command: unknown, options: ConfigLoadOptions = {}) => applyLifecycle(root, command, options, 'park');
export const advanceConfiguredRunLifecycle = (root: string, query: RunQuery, options: ConfigLoadOptions = {}) => applyLifecycle(root, query, options, true);
async function applyLifecycle(projectRoot: string, input: unknown, options: ConfigLoadOptions, maintain: boolean | 'park') {
  try {
    const command = maintain === 'park' ? runProgressionParkCommandSchema.parse(input) : maintain ? runQuerySchema.parse(input) : runLifecycleCommandSchema.parse(input);
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write');
    const source = { async load() { return (await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write')).document; } }, verifier = { async verify() { return principal; } }, authorization = new RunPolicyAuthorization(source);
    const store = await openSqliteInventoryReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs }); try {
      const integrity = maintain === true ? null : await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
      const approvals = maintain ? null : openSqliteApprovalStore(await path(), config.storage.sqlite);
      const peer = localPrincipalPeer();
      const decisions = approvals ? new RunDecisionApprovalBroker(approvals.store, integrity!, source,
        () => attestLocalInteractiveTerminal(peer?.pid, peer?.uid), Date.now, config.approvals.requestTtlMs, config.approvals.requestTtlMs, resolveLocale(undefined, options.env ?? process.env)) : undefined;
      try {
      const policy = new DispatchPolicyAuthorization(source);
      const app = new RunLifecycleApplication({ loadRun: (scope, run) => store.loadRun(scope, run), hasTaskEvaluation: (identity, revision) => store.hasTaskEvaluation(identity, revision),
        loadRunReceipt: (scope, commandId) => store.loadRunReceipt(scope, commandId),
        async commitRunLifecycle(write, audit) {
          const writer = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
          try { return await writer.commitRunLifecycle(write, audit); } finally { writer.close(); }
        } }, verifier, authorization,
        { authorize: (identity, actor) => policy.authorizeIdentity('evaluate', identity, actor) }, audit => new AuditApplication(audit, integrity!),
        Date.now, config.runRuntime.parking.timeoutMs, document.revision, decisions);
      const receipt = maintain === 'park' ? await app.parkProgression(command) : maintain ? await app.advance(command) : await app.execute(command);
      if (!receipt) return null;
      return Object.freeze({ schemaVersion: 1 as const, layout, lifecycle: { schemaVersion: 1 as const, commandId: receipt.commandId, run: projectRunView(receipt.snapshot) } });
      } finally { approvals?.close(); }
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
