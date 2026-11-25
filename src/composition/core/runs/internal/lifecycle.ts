import { DeckentError, ErrorRegistry, productResourcePath, resolveLocale, resolveProductLayout, withConfigWriteLock, type ConfigLoadOptions, type IntegrityAuthority } from '#platform/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, openSqliteApprovalStore, openLocalIntegrityAuthority, openSqliteInventoryReader, type SqliteInventoryReader } from '#adapters/index.js';
import { verifiedPrincipal, RunDecisionApprovalBroker, AuditApplication, DispatchPolicyAuthorization, RunLifecycleApplication, runLifecycleCommandSchema, runProgressionParkCommandSchema, runSafetyHoldOnceSchema, RunPolicyAuthorization, projectRunView, runQuerySchema, type RunQuery } from '#engine/index.js';
import { openConfiguredLedger, loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { withLayoutPolicyLock } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
export const applyConfiguredRunLifecycle = (root: string, command: unknown, options: ConfigLoadOptions = {}, binding?: string) => applyLifecycle(root, command, options, false, binding);
export const parkConfiguredRunProgression = (root: string, command: unknown, options: ConfigLoadOptions = {}) => applyLifecycle(root, command, options, 'park');
export const advanceConfiguredRunLifecycle = (root: string, query: RunQuery, options: ConfigLoadOptions = {}) => applyLifecycle(root, query, options, true);
/** S6R-3: the Nervous broker's safety hold (source bound here, never by a caller; not exported to any surface). */
export const holdConfiguredRunForNervous = (root: string, command: unknown, options: ConfigLoadOptions = {}) => applyLifecycle(root, command, options, 'nervous');
/** Owner 196: a hold or resume holds the lock of the governed and raw project settings writers (fixed bootstrap path) from before its last
 * bound read until its commit is classified. Not taken, it is refused before any Run effect and exits 1 like every refused Run control
 * (owner 155); taken, a failed release no longer changes the classified outcome (a committed hold is never reported as not done).
 * `settings` is the target project's own settings document at the project root the initial read resolved (relative SDK roots
 * included), also when a global-only read used the global document (adapters/core/config-file/internal/documents.ts:10, same path). */
async function withProjectSettingsLock<T>(settings: string, timeoutMs: number, work: () => Promise<T>): Promise<T> {
  const held: { outcome?: PromiseSettledResult<T> } = {};
  try {
    await withConfigWriteLock(settings, async () => { [held.outcome] = await Promise.allSettled([Promise.resolve().then(work)]); }, timeoutMs);
  } catch (error) {
    if (!held.outcome) {
      const refused = error instanceof DeckentError ? error : ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: error });
      throw new DeckentError(refused.code, refused.message, refused.suggestion, refused.docLink, refused.whatHappened, refused.why, refused.howToFix, 'error', { cause: refused }, refused.localize, refused.params);
    }
  }
  const outcome = held.outcome!;
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
}
// Hold/resume cannot route approval cards. Any attempt to use those ports fails closed.
const controlOnly = new Proxy({} as ConstructorParameters<typeof RunDecisionApprovalBroker>[0] & IntegrityAuthority, {
  get() { throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE'); },
});
async function applyLifecycle(projectRoot: string, input: unknown, options: ConfigLoadOptions, maintain: boolean | 'park' | 'nervous', selected?: string) {
  try {
    const command = maintain === 'park' ? runProgressionParkCommandSchema.parse(input) : maintain === 'nervous' ? runSafetyHoldOnceSchema.parse(input) : maintain ? runQuerySchema.parse(input) : runLifecycleCommandSchema.parse(input);
    const control = !maintain && 'action' in command && (command.action === 'hold' || command.action === 'resume'), channel = control ? localPrincipalChannel() : undefined;
    const verifyBinding = (expected: string | undefined, actual: string) => {
      if (expected !== actual) throw ErrorRegistry.createError('RUN_CONTROL_BINDING_CHANGED');
    };
    const loadContext = async (expected?: string) => {
      const context = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, control ? 'read' : 'write', undefined,
        expected === undefined || channel ? undefined : location => verifyBinding(expected.split(':')[0], location));
      if (expected !== undefined) verifyBinding(expected, context.runControlBinding());
      return context;
    };
    const initial = await loadContext(control && !channel ? selected : undefined), { config, layout, document, principal, path } = initial;
    const binding = control ? initial.runControlBinding() : undefined, boundContext = () => loadContext(binding);
    const source = { async load() { return (await boundContext()).document; } }, verifier = verifiedPrincipal(principal), authorization = new RunPolicyAuthorization(source);
    let store: SqliteInventoryReader | undefined;
    const reader = async () => store ??= await openSqliteInventoryReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
    try {
      if (!channel) await reader();
      let integrity = maintain === true || control ? null : await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
      const approvals = maintain || control ? null : openSqliteApprovalStore(await path(), config.storage.sqlite);
      const peer = localPrincipalPeer();
      const decisions = maintain ? undefined : new RunDecisionApprovalBroker(approvals?.store ?? controlOnly, integrity ?? controlOnly, source,
        () => channel ? Promise.resolve(false) : attestLocalInteractiveTerminal(peer?.pid, peer?.uid), Date.now, config.approvals.requestTtlMs, config.approvals.requestTtlMs, resolveLocale(undefined, options.env ?? process.env, config.language));
      try {
      const policy = new DispatchPolicyAuthorization(source);
      const app = new RunLifecycleApplication({ loadRun: async (scope, run) => (await reader()).loadRun(scope, run), hasTaskEvaluation: async (identity, revision) => (await reader()).hasTaskEvaluation(identity, revision),
        loadRunReceipt: async (scope, commandId) => (await reader()).loadRunReceipt(scope, commandId),
        async commitRunLifecycle(write, audit, recheck) {
          const commit = async () => {
            const admitted = control ? await boundContext() : initial;
            if (recheck) write = await recheck(admitted.document);
            if (control) {
              await admitted.admitWrite();
              integrity = await openLocalIntegrityAuthority(admitted.layout, admitted.config.approvals.keyFile, true);
            }
            const writer = await openConfiguredLedger(admitted, { migration: 'forbid' });
            try { return await writer.commitRunLifecycle(write, audit); } finally { writer.close(); }
          };
          if (!control) return commit();
          let entered = false;
          // Owner 196: the project settings lock first, the MCP policy lock inside it (the setup permission order).
          return withProjectSettingsLock(productResourcePath(resolveProductLayout({ projectRoot: config.projectRoot, platform: layout.platform }), 'config'), config.configFile.writeLockTimeoutMs, !channel ? commit
            : () => withLayoutPolicyLock(layout, () => { entered = true; return commit(); }).catch((error: unknown) => {
              throw entered || error instanceof DeckentError ? error : ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: error });
            }));
        } }, verifier, authorization,
        { authorize: (identity, actor) => policy.authorizeIdentity('evaluate', identity, actor) }, audit => new AuditApplication(audit, integrity!),
        Date.now, config.runRuntime.parking.timeoutMs, document.revision, decisions,
        { maxWaitMs: config.runRuntime.quotaRecovery.maxWaitMs, maxRewaits: config.runRuntime.quotaRecovery.maxRewaits });
      const receipt = maintain === 'park' ? await app.parkProgression(command) : maintain === 'nervous' ? await app.holdOnce('nervous', command) : maintain ? await app.advance(command) : await app.execute(command, undefined, channel);
      if (!receipt) return null;
      return Object.freeze({ schemaVersion: 1 as const, layout, lifecycle: { schemaVersion: 1 as const, commandId: receipt.commandId, run: projectRunView(receipt.snapshot) } });
      } finally { approvals?.close(); }
    } finally { store?.close(); }
  } catch (error) {
    // Preserve the binding refusal through policy reads, then conceal it at the MCP boundary.
    if (error instanceof DeckentError && error.code === 'RUN_CONTROL_BINDING_CHANGED' && localPrincipalChannel())
      throw ErrorRegistry.createError('POLICY_DENIED');
    throw queryFailure(error);
  }
}
