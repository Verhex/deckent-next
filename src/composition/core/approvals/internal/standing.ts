import { automationMarker, ErrorRegistry, SystemTrustedClock, resolveLocale, type ConfigLoadOptions } from '#platform/index.js';
import { executionPermissionCoverage, verifiedPrincipal, ApprovalApplication, AuditApplication, resolveAuditedApprovalAssurance, FIRST_RUN_TOOL_NAMES, McpToolGrants, PersistentStanding, PolicyAdministrationApplication,
  PolicyAdministrationInspection, PolicyTemplateUpgrade, assertAuthorityWitness, StandingGrantsInspection, firstRunServiceIdentity, type StandingGrantsPage, type PolicyAdministrationQuery, type PolicyAdministrationStatus, type McpToolGrantOutcome, type McpToolGrantTarget, type TemplateUpgradeResult,
  type PersistentStandingDependencies, type StandingGrantView } from '#engine/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, LocalOsSessionAuthority, openLocalIntegrityAuthority, openReadOnlyAuditStore, openSqliteApprovalStore, openSqliteAuditStore } from '#adapters/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { openConfiguredLedger, loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
type ScopeContext = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
type Person = ScopeContext['principal'];
/** The caller's own standing approvals for `deckent policy grants --mine` / `revoke` (G6): local OS person; a revoke is the governed `policy.administer@1` change, `confirm` is the person's own answer. */
function withStanding<T>(root: string, scopeId: string, options: ConfigLoadOptions, access: 'read' | 'write', use: (standing: PersistentStanding, person: Person) => Promise<T>): Promise<T> {
  return withPolicyAdministration(root, scopeId, options, access, (deps, person) => use(new PersistentStanding(deps), person));
}
export async function withPolicyAdministration<T>(root: string, scopeId: string, options: ConfigLoadOptions, access: 'read' | 'write',
  use: (deps: PersistentStandingDependencies & { readonly policy: import('#engine/index.js').PolicySource & Partial<import('#engine/index.js').AuthorityHistorySource>; readonly effects?: import('#engine/index.js').EffectStore; readonly serviceIdentity?: { readonly scopeId: string; readonly serviceId: string } | null }, person: Person, document: ScopeContext['document']) => Promise<T>): Promise<T> {
  try {
    const { config, layout, principal, path, document } = await loadConfiguredScopeContext(root, scopeId, options, access);
    const source = contextPolicySource({ layout, config });
    const denied = () => Promise.reject(new Error('read-only'));
    if (access === 'read') return await use({ policy: source, administration: { submit: denied }, approve: denied, serviceIdentity: config.service.identity }, principal, document);
    const peer = localPrincipalPeer(), clock = new SystemTrustedClock(), sessions = await LocalOsSessionAuthority.create(principal.scopeIds, config.approvals.sessionTtlMs, clock, peer);
    const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true), ledger = await path();
    const effects = await openConfiguredLedger({ config, path: async () => ledger }, { migration: 'forbid' }), journal = openSqliteApprovalStore(ledger, config.storage.sqlite);
    const auditStore = await openSqliteAuditStore(ledger, config.storage.sqlite, 'forbid');
    try {
      const audit = new AuditApplication(auditStore, integrity);
      const administration = new PolicyAdministrationApplication({ authority: source, policy: source, effects, approvals: journal.store, integrity, sessions, clock,
        requestTtlMs: config.approvals.requestTtlMs, locale: resolveLocale(undefined, options.env, config.language), audit: event => { audit.record(event); } });
      const approve = async (approval: { approvalId: string; revision: number }, commandId: string, reason: string) => {
        if (!await attestLocalInteractiveTerminal(peer?.pid, peer?.uid)) throw ErrorRegistry.createError('APPROVAL_INTERACTIVE_REQUIRED');
        sessions.requireInteractiveTerminal();
        const producers = resolveAuditedApprovalAssurance(config.approvals.assuranceProducers, undefined,
          { scopeId, principal, policyRevision: document.revision, atMs: clock.sample().wallMs }, event => { audit.record(event); });
        return new ApprovalApplication(journal.store,
        verifiedPrincipal(principal), sessions, source, integrity, clock, 'local-sdk', config.approvals.pageSize, undefined, undefined, { producers, peerPid: peer?.pid ?? null, interactive: () => attestLocalInteractiveTerminal(peer?.pid, peer?.uid) })
        .decide({ schemaVersion: 1, scopeId, approvalId: approval.approvalId, commandId, expectedRevision: approval.revision, decision: 'allow', reason });
      };
      return await use({ administration, approve, policy: source, effects, serviceIdentity: config.service.identity }, principal, document);
    } finally { journal.close(); effects.close(); auditStore.close(); }
  } catch (error) { throw queryFailure(error); }
}
export function listConfiguredStandingGrants(root: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<readonly StandingGrantView[]> {
  return withStanding(root, scopeId, options, 'read', (standing, person) => standing.list(scopeId, person));
}
/** CA-1 `deckent policy grants --all`: everyone's standing approvals, only if `policy inspect-standing-grants` allows this person; the ledger opens read-only after that. */
export async function listConfiguredAllStandingGrants(root: string, input: { readonly scopeId: string; readonly after?: string }, options: ConfigLoadOptions = {}): Promise<StandingGrantsPage> {
  try {
    const { config, layout, principal, path } = await loadConfiguredScopeContext(root, input.scopeId, options, 'read');
    const history = { open: async (scopeId: string) => {
      const store = await openReadOnlyAuditStore(await path(), config.storage.sqlite);
      try { const audit = new AuditApplication(store, await openLocalIntegrityAuthority(layout, config.approvals.keyFile));
        return { page: (after: number, limit: number) => audit.listKind(scopeId, 'authority-change', after, limit).map(({ sequence, event }) =>
          ({ sequence, atMs: event.atMs, inputDigest: event.subject.kind === 'authority-change' ? event.subject.inputDigest : '' })), close: () => store.close() };
      } catch (error) { store.close(); throw error; } } };
    return await new StandingGrantsInspection({ policy: contextPolicySource({ layout, config }), history })
      .list({ schemaVersion: 1, scopeId: input.scopeId, ...(input.after === undefined ? {} : { after: input.after }) }, principal);
  } catch (error) { throw queryFailure(error); }
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
  const refuse = (error: unknown): McpToolGrantOutcome => {
    const code = (error as { code?: unknown })?.code;
    return { status: 'refused', reason: code === 'POLICY_DENIED' ? 'delegation' : String(code ?? 'failed') };
  };
  const isApprover = (person: Person) => person.issuer === approver.issuer && person.subject === approver.subject;
  const run = (work: (grants: McpToolGrants, person: Person) => Promise<McpToolGrantOutcome>) => withPolicyAdministration(root, scopeId, options, 'write', (deps, person) =>
    isApprover(person) ? work(new McpToolGrants(deps), person) : Promise.resolve({ status: 'refused' as const, reason: 'principal' }))
    // A person refused write access to this scope holds no authority to grant there either (the same reason as the delegation bound's).
    .catch(refuse);
  return {
    grant: (server, tools) => run((grants, person) => grants.grant({ scopeId, principal: person, server, tools, reason: `MCP trust approval of ${server.name}` })),
    async revoke(server) {
      // Trust withdrawal already settled. Check the witness before policy administration can submit a card.
      try {
        const config = await loadComposedConfig(root, { ...options, heal: false }), peer = localPrincipalPeer();
        const markers = config.cli.agentEnvironment, channel = localPrincipalChannel();
        const aiMarked = automationMarker(process.env, markers) === 'agent' || automationMarker(options.env ?? process.env, markers) === 'agent';
        const localPerson = channel === undefined && !aiMarked;
        const witnessed = localPerson && await attestLocalInteractiveTerminal(peer?.pid, peer?.uid);
        if (localPerson && !witnessed) {
          // Use the validated read snapshot so a failed policy read cannot be mistaken for absence.
          const absent = await withPolicyAdministration(root, scopeId, options, 'read', async (deps, person, document) => {
            if (!isApprover(person)) return false;
            const grants = new McpToolGrants({ ...deps, policy: { load: async () => document } });
            return (await grants.inspect({ scopeId, principal: person, server })).status === 'none';
          }).catch(() => false);
          if (absent) return { status: 'none' };
        }
        await assertAuthorityWitness('mcpToolGrantRevoke', channel, { attest: async () => witnessed });
      } catch (error) { return refuse(error); }
      return run((grants, person) => grants.revoke({ scopeId, principal: person, server, reason: `MCP trust of ${server.name} withdrawn` }));
    },
    // Read only (no administration opened): the same person's grant of the server, for `/mcp` detail and `deckent mcp get`.
    inspect: server => withPolicyAdministration(root, scopeId, options, 'read', (deps, person) => isApprover(person)
      ? new McpToolGrants(deps).inspect({ scopeId, principal: person, server }) : Promise.resolve({ status: 'none' as const })),
  };
}
/**
 * `deckent policy upgrade --template current`: current first-run additions for this local person through the governed chain. Preview reads
 * only (no administration opened); apply and rollback run `policy.administer@1` as this person (its card decided by them, I2, audit, archive).
 */
export function configuredPolicyTemplateUpgrade(root: string, scopeId: string, options: ConfigLoadOptions, input: { readonly mode: 'preview' | 'apply' | 'rollback'; readonly previewRollback?: boolean;
  readonly expect?: string; readonly reason: string; readonly only?: 'ai-proposals' | 'ai-execution' }, agents?: readonly string[], verifiedRoot?: import('#domain/index.js').Policy | null): Promise<TemplateUpgradeResult> {
  return runConfiguredPolicyTemplateUpgrade(root, scopeId, options, input, agents, verifiedRoot);
}
/** The interactive command binds its in-process preview to the same witnessed writer. */
export function applyReviewedPolicyTemplateUpgrade(root: string, scopeId: string, options: ConfigLoadOptions, input: Parameters<typeof configuredPolicyTemplateUpgrade>[3],
  reviewedRules: readonly unknown[], agents?: readonly string[]): Promise<TemplateUpgradeResult> {
  return runConfiguredPolicyTemplateUpgrade(root, scopeId, options, input, agents, undefined, reviewedRules);
}
async function runConfiguredPolicyTemplateUpgrade(root: string, scopeId: string, options: ConfigLoadOptions, input: Parameters<typeof configuredPolicyTemplateUpgrade>[3],
  agents: readonly string[] | undefined, verifiedRoot?: import('#domain/index.js').Policy | null, reviewedRules?: readonly unknown[]): Promise<TemplateUpgradeResult> {
  if (input.mode !== 'preview' && input.only !== 'ai-proposals') {
    const config = await loadComposedConfig(root, { ...options, heal: false });
    await assertAuthorityWitness('policyTemplateUpgrade', localPrincipalChannel(), { attest: async () =>
      automationMarker(options.env ?? process.env, agents ?? config.cli.agentEnvironment) === null && await attestLocalInteractiveTerminal() });
  }
  return withPolicyAdministration(root, scopeId, options, input.mode === 'preview' ? 'read' : 'write', (deps, person) =>
    new PolicyTemplateUpgrade(deps, { ...FIRST_RUN_TOOL_NAMES, serviceId: firstRunServiceIdentity(scopeId, deps.serviceIdentity ?? null).serviceId }, reviewedRules)
      .run({ scopeId, principal: person, mode: input.mode, reason: input.reason, ...(input.previewRollback ? { previewRollback: true } : {}), ...(input.expect === undefined ? {} : { expect: input.expect }), ...(input.only ? { only: input.only } : {}) }, input.mode === 'preview' ? verifiedRoot : null));
}
/** Standing coverage across resource ids in this scope. A concrete Run may have narrower permissions. */
export async function inspectConfiguredExecutionPermission(root: string, scopeId: string, options: ConfigLoadOptions) {
  const { document, principal } = await loadConfiguredScopeContext(root, scopeId, options, 'read');
  return executionPermissionCoverage(document, principal, scopeId);
}

/** CLI, SDK, MCP and doctor share the same scoped, read-only policy observation. */
export function inspectConfiguredPolicyAdministration(root: string, query: PolicyAdministrationQuery, options: ConfigLoadOptions = {}): Promise<PolicyAdministrationStatus> {
  return withPolicyAdministration(root, query.scopeId, options, 'read', (deps, person) => new PolicyAdministrationInspection(deps.policy).inspect(person, query));
}
