import { ErrorRegistry, resolveLocale, type ConfigLoadOptions, type IntegrityAuthority } from '#platform/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, openSqliteApprovalStore, openLocalIntegrityAuthority, openSqliteInventoryReader, type SqliteInventoryReader } from '#adapters/index.js';
import { verifiedPrincipal, RunDecisionApprovalBroker, AuditApplication, DispatchPolicyAuthorization, RunLifecycleApplication, runLifecycleCommandSchema, runProgressionParkCommandSchema, runSafetyHoldOnceSchema, RunPolicyAuthorization, projectRunView, runQuerySchema, type RunQuery } from '#engine/index.js';
import { openConfiguredLedger, loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
export const applyConfiguredRunLifecycle = (root: string, command: unknown, options: ConfigLoadOptions = {}) => applyLifecycle(root, command, options, false);
export const parkConfiguredRunProgression = (root: string, command: unknown, options: ConfigLoadOptions = {}) => applyLifecycle(root, command, options, 'park');
export const advanceConfiguredRunLifecycle = (root: string, query: RunQuery, options: ConfigLoadOptions = {}) => applyLifecycle(root, query, options, true);
/** S6R-3: the Nervous broker's safety hold (source bound here, never by a caller; not exported to any surface). */
export const holdConfiguredRunForNervous = (root: string, command: unknown, options: ConfigLoadOptions = {}) => applyLifecycle(root, command, options, 'nervous');
// Hold/resume cannot route approval cards. Any attempt to use those ports fails closed.
const controlOnly = new Proxy({} as ConstructorParameters<typeof RunDecisionApprovalBroker>[0] & IntegrityAuthority, {
  get() { throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE'); },
});
async function applyLifecycle(projectRoot: string, input: unknown, options: ConfigLoadOptions, maintain: boolean | 'park' | 'nervous') {
  try {
    const command = maintain === 'park' ? runProgressionParkCommandSchema.parse(input) : maintain === 'nervous' ? runSafetyHoldOnceSchema.parse(input) : maintain ? runQuerySchema.parse(input) : runLifecycleCommandSchema.parse(input);
    const channel = !maintain && 'action' in command && (command.action === 'hold' || command.action === 'resume') ? localPrincipalChannel() : undefined;
    const access = channel === 'mcp' ? 'read' : 'write';
    const { config, layout, document, principal, path } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, access);
    const source = { async load() { return (await loadConfiguredScopeContext(projectRoot, command.scopeId, options, access)).document; } }, verifier = verifiedPrincipal(principal), authorization = new RunPolicyAuthorization(source);
    let store: SqliteInventoryReader | undefined;
    const reader = async () => store ??= await openSqliteInventoryReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
    try {
      if (!channel) await reader();
      let integrity = maintain === true || channel ? null : await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
      const approvals = maintain || channel ? null : openSqliteApprovalStore(await path(), config.storage.sqlite);
      const peer = localPrincipalPeer();
      const decisions = maintain ? undefined : new RunDecisionApprovalBroker(approvals?.store ?? controlOnly, integrity ?? controlOnly, source,
        // The MCP channel carries no terminal witness.
        () => channel ? Promise.resolve(false) : attestLocalInteractiveTerminal(peer?.pid, peer?.uid), Date.now, config.approvals.requestTtlMs, config.approvals.requestTtlMs, resolveLocale(undefined, options.env ?? process.env, config.language));
      try {
      const policy = new DispatchPolicyAuthorization(source);
      const app = new RunLifecycleApplication({ loadRun: async (scope, run) => (await reader()).loadRun(scope, run), hasTaskEvaluation: async (identity, revision) => (await reader()).hasTaskEvaluation(identity, revision),
        loadRunReceipt: async (scope, commandId) => (await reader()).loadRunReceipt(scope, commandId),
        async commitRunLifecycle(write, audit) {
          if (channel) {
            await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write');
            integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
          }
          const writer = await openConfiguredLedger({ config, path: () => path() }, { migration: 'forbid' });
          try { return await writer.commitRunLifecycle(write, audit); } finally { writer.close(); }
        } }, verifier, authorization,
        { authorize: (identity, actor) => policy.authorizeIdentity('evaluate', identity, actor) }, audit => new AuditApplication(audit, integrity!),
        Date.now, config.runRuntime.parking.timeoutMs, document.revision, decisions,
        { maxWaitMs: config.runRuntime.quotaRecovery.maxWaitMs, maxRewaits: config.runRuntime.quotaRecovery.maxRewaits });
      const receipt = maintain === 'park' ? await app.parkProgression(command) : maintain === 'nervous' ? await app.holdOnce('nervous', command) : maintain ? await app.advance(command) : await app.execute(command, undefined, channel);
      if (!receipt) return null;
      return Object.freeze({ schemaVersion: 1 as const, layout, lifecycle: { schemaVersion: 1 as const, commandId: receipt.commandId, run: projectRunView(receipt.snapshot) } });
      } finally { approvals?.close(); }
    } finally { store?.close(); }
  } catch (error) { throw queryFailure(error); }
}
