import { userInfo } from 'node:os';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { LocalOsSessionAuthority, openLocalIntegrityAuthority, openSqliteApprovalStore, openSqliteAttemptStore, readOperationsConfig,
  registerProviderConfig, resolveOperationCatalog, resolveOperationTargets } from '#adapters/index.js';
import { EffectApplication, OperationApprovalBroker, OperationPolicyAuthorization, awaitOperationApproval, type EffectOutcome } from '#engine/index.js';
import { effectCommandSchema, type EffectCommand } from '#domain/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

/** Query ('read') or command ('write') admission of the scope; stated by every entry below (Astra 2126 R1). */
type ScopeAccess = Parameters<typeof loadConfiguredScopeContext>[3];

/** Optional wait for a pending operation approval (SDK/terminal): the core never blocks; the wait polls the stored request and, on
 * `allow`, resubmits the same command once. A timed-out or cancelled wait returns the pending outcome and closes nothing. */
export interface OperationSubmitOptions { readonly awaitApproval?: { readonly timeoutMs: number; readonly pollMs?: number; readonly signal?: AbortSignal } }
type Wait = (scopeId: string, approvalId: string, wait: NonNullable<OperationSubmitOptions['awaitApproval']>) => Promise<'allow' | 'deny' | 'expired' | 'timeout' | 'cancelled'>;

/** Local SDK/CLI producer for catalog operations. Principal and session come from configuration and the local OS session, never from
 * the wire; the catalog is the unified resolver (Core code operations, registered module operations, config catalog) and targets are
 * resolved from configuration through the same adapter registry (Core entries and registered modules).
 * A required approval goes through the operation approval broker (C12 G2): the first submission opens the request and reports it as
 * pending; the same command resubmitted after an `allow` applies the effect and consumes the approval. */
async function withEffects<T>(root: string, scopeId: string, options: ConfigLoadOptions, access: ScopeAccess,
  use: (application: EffectApplication, wait: Wait) => Promise<T>): Promise<T> {
  try {
    registerProviderConfig();
    const { config, layout, principal, path } = await loadConfiguredScopeContext(root, scopeId, options, access);
    const operations = readOperationsConfig(config as unknown as Record<string, unknown>);
    const catalog = resolveOperationCatalog(operations), targets = resolveOperationTargets(operations);
    const clock = new SystemTrustedClock();
    const sessions = await LocalOsSessionAuthority.create(principal.scopeIds, config.approvals.sessionTtlMs, clock);
    const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
    const policy = new OperationPolicyAuthorization(source);
    // A producer of approvals, like Run reservation and the agent turn: the integrity key is created on first use (decisions only read it).
    const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
    const ledger = await path();
    const store = await openSqliteAttemptStore(ledger, config.storage.sqlite, 'forbid');
    const journal = openSqliteApprovalStore(ledger, config.storage.sqlite);
    try {
      const broker = new OperationApprovalBroker(journal.store, integrity, source, clock,
        { requestTtlMs: config.approvals.requestTtlMs, defaultAdmitWithinMs: config.approvals.requestTtlMs });
      const application = new EffectApplication(catalog, targets, store, broker, sessions, policy, clock);
      return await use(application, (waitScope, approvalId, wait) => awaitOperationApproval(journal.store, integrity, { scopeId: waitScope, approvalId },
        () => clock.sample().wallMs, clock.sample().wallMs + wait.timeoutMs, wait.signal, wait.pollMs));
    } finally { journal.close(); store.close(); }
  } catch (error) { throw queryFailure(error); }
}
function parsed(input: unknown): EffectCommand {
  try { return effectCommandSchema.parse(input); } catch (error) { throw queryFailure(error); }
}
async function submitConfiguredOperation(root: string, action: 'execute' | 'compensate', input: EffectCommand, options: ConfigLoadOptions, submit?: OperationSubmitOptions): Promise<EffectOutcome> {
  const command = parsed(input);
  return withEffects(root, command.scopeId, options, 'write', async (application, wait) => {
    const first = await application.submit(action, command);
    if (first.status !== 'approval-pending' || !submit?.awaitApproval) return first;
    const decided = await wait(first.scopeId, first.approval.approvalId, submit.awaitApproval);
    if (decided === 'timeout' || decided === 'cancelled') return first;
    // One resubmission: an allow applies the effect; a deny or an expired request is the broker's typed refusal.
    return application.submit(action, command);
  });
}
export async function executeConfiguredOperation(root: string, input: EffectCommand, options: ConfigLoadOptions = {}, submit?: OperationSubmitOptions) {
  return submitConfiguredOperation(root, 'execute', input, options, submit);
}
export async function compensateConfiguredOperation(root: string, input: EffectCommand, options: ConfigLoadOptions = {}, submit?: OperationSubmitOptions) {
  return submitConfiguredOperation(root, 'compensate', input, options, submit);
}
export async function inspectConfiguredOperation(root: string, query: { readonly scopeId: string; readonly commandId: string }, options: ConfigLoadOptions = {}) {
  return withEffects(root, query.scopeId, options, 'read', async application => {
    const record = await application.inspect(query.scopeId, query.commandId);
    return Object.freeze({ schemaVersion: 1 as const, record });
  });
}
