import { userInfo } from 'node:os';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { ApprovalApplication, AuditApplication, McpToolGrants, PersistentStanding, PolicyAdministrationApplication, type McpToolGrantOutcome, type McpToolGrantTarget,
  type PersistentStandingDependencies, type StandingGrantView } from '#engine/index.js';
import { LocalOsSessionAuthority, openLocalIntegrityAuthority, openSqliteApprovalStore, openSqliteAttemptStore, openSqliteAuditStore } from '#adapters/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

type Person = Awaited<ReturnType<typeof loadConfiguredScopeContext>>['principal'];
/** The caller's own standing approvals for `deckent policy grants --mine` / `revoke` (G6): local OS person; a revoke is the governed `policy.administer@1` change, `confirm` is the person's own answer. */
function withStanding<T>(root: string, scopeId: string, options: ConfigLoadOptions, access: 'read' | 'write', use: (standing: PersistentStanding, person: Person) => Promise<T>): Promise<T> {
  return withPolicyAdministration(root, scopeId, options, access, (deps, person) => use(new PersistentStanding(deps), person));
}
/** The local OS person's governed `policy.administer@1` chain (read: a policy source only; write: the administration, and the approval decided as that person). */
async function withPolicyAdministration<T>(root: string, scopeId: string, options: ConfigLoadOptions, access: 'read' | 'write',
  use: (deps: PersistentStandingDependencies, person: Person) => Promise<T>): Promise<T> {
  try {
    const { config, layout, principal, path } = await loadConfiguredScopeContext(root, scopeId, options, access);
    const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
    const denied = () => Promise.reject(new Error('read-only'));
    if (access === 'read') return await use({ policy: source, administration: { submit: denied }, approve: denied }, principal);
    const clock = new SystemTrustedClock(), sessions = await LocalOsSessionAuthority.create(principal.scopeIds, config.approvals.sessionTtlMs, clock);
    const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true), ledger = await path();
    const effects = await openSqliteAttemptStore(ledger, config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid'), journal = openSqliteApprovalStore(ledger, config.storage.sqlite);
    const auditStore = await openSqliteAuditStore(ledger, config.storage.sqlite, 'forbid');
    try {
      const audit = new AuditApplication(auditStore, integrity);
      const administration = new PolicyAdministrationApplication({ authority: source, policy: source, effects, approvals: journal.store, integrity, sessions, clock,
        requestTtlMs: config.approvals.requestTtlMs, audit: event => { audit.record(event); } });
      const approve = (approval: { approvalId: string; revision: number }, commandId: string, reason: string) => new ApprovalApplication(journal.store,
        { verify: async () => principal }, sessions, source, integrity, clock, 'local-sdk', config.approvals.pageSize)
        .decide({ schemaVersion: 1, scopeId, approvalId: approval.approvalId, commandId, expectedRevision: approval.revision, decision: 'allow', reason });
      return await use({ administration, approve, policy: source }, principal);
    } finally { journal.close(); effects.close(); auditStore.close(); }
  } catch (error) { throw queryFailure(error); }
}
export function listConfiguredStandingGrants(root: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<readonly StandingGrantView[]> {
  return withStanding(root, scopeId, options, 'read', (standing, person) => standing.list(scopeId, person));
}
/** Removes one of the caller's own standing grants after `confirm` (shown the grant); false = the person declined, nothing changed. */
export function revokeConfiguredStandingGrant(root: string, input: { readonly scopeId: string; readonly id: string; readonly reason: string;
  readonly confirm: (grant: StandingGrantView) => Promise<boolean> }, options: ConfigLoadOptions = {}): Promise<{ readonly revoked: boolean; readonly grant: StandingGrantView | null }> {
  return withStanding(root, input.scopeId, options, 'write', async (standing, person) => {
    const grant = (await standing.list(input.scopeId, person)).find(entry => entry.id === input.id) ?? null;
    if (!grant || !await input.confirm(grant)) return { revoked: false, grant };
    await standing.revoke({ scopeId: input.scopeId, principal: person, id: input.id, reason: input.reason });
    return { revoked: true, grant };
  });
}
/**
 * MCP trust → permission (L1 K1): the tool-grant port of one approving person in one scope. The grant is written as the local OS person of this
 * process (the same person the CLI and the local service run for); an approver who is not that person gets no grant (`principal`), never a
 * grant in someone else's name. Every refusal is a typed outcome; trust stays recorded by its own path.
 */
export function configuredMcpToolGrants(root: string, scopeId: string, options: ConfigLoadOptions, approver: { readonly issuer: string; readonly subject: string }):
  { grant(server: McpToolGrantTarget, tools: readonly string[]): Promise<McpToolGrantOutcome>; revoke(server: McpToolGrantTarget): Promise<McpToolGrantOutcome>;
    inspect(server: McpToolGrantTarget): Promise<{ readonly status: 'granted'; readonly scopes: 'all' | readonly string[] } | { readonly status: 'none' }> } {
  const run = (work: (grants: McpToolGrants, person: Person) => Promise<McpToolGrantOutcome>) => withPolicyAdministration(root, scopeId, options, 'write', (deps, person) =>
    person.issuer === approver.issuer && person.subject === approver.subject ? work(new McpToolGrants(deps), person) : Promise.resolve({ status: 'refused' as const, reason: 'principal' }))
    // A person refused write access to this scope holds no authority to grant there either (the same reason as the delegation bound's).
    .catch((error: unknown) => { const code = (error as { code?: unknown })?.code; return { status: 'refused' as const, reason: code === 'POLICY_DENIED' ? 'delegation' : String(code ?? 'failed') }; });
  return {
    grant: (server, tools) => run((grants, person) => grants.grant({ scopeId, principal: person, server, tools, reason: `MCP trust approval of ${server.name}` })),
    revoke: server => run((grants, person) => grants.revoke({ scopeId, principal: person, server, reason: `MCP trust of ${server.name} withdrawn` })),
    // Read only (no administration opened): the same person's grant of the server, for `/mcp` detail and `deckent mcp get`.
    inspect: server => withPolicyAdministration(root, scopeId, options, 'read', (deps, person) => person.issuer === approver.issuer && person.subject === approver.subject
      ? new McpToolGrants(deps).inspect({ scopeId, principal: person, server }) : Promise.resolve({ status: 'none' as const })),
  };
}
