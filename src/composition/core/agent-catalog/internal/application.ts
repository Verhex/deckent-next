import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { AgentCatalogApplication, AgentCatalogPolicyAuthorization, AgentCatalogStoreError, SignerKeyApplication, registeredWorkClassIds, agentDefineCommandSchema as defineAgent,
  agentInspectQuerySchema as inspectAgent, agentListQuerySchema as listAgents, skillDefineCommandSchema as defineSkill, skillImportCommandSchema as importSkill,
  skillInspectQuerySchema as inspectSkill, skillListQuerySchema as listSkills, signerListQuerySchema as listSigners, signerEnrolCommandSchema as enrolSigner,
  signerAddCommandSchema as addSigner, signerRevokeCommandSchema as revokeSigner, signerRepairCommandSchema as repairSigners, assertAuthorityWitness, type AuthorityWitness } from '#engine/index.js';
import { executionRegistrySchema } from '#domain/index.js';
import { openSqliteAgentCatalogStore, openLocalIntegrityAuthority, attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, localSignerKeyCustody, FileSignerRevocationLog,
  NATIVE_PROMPT_LIMITS } from '#adapters/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
const schemas = { listAgents, inspectAgent, listSkills, inspectSkill, defineAgent, defineSkill, importSkill, listSigners, enrolSigner, addSigner, revokeSigner, repairSigners };
/** S8-5: the signer cards and their `SignerKeyApplication` method; every other action is the catalog application's. */
const SIGNER_METHODS = { listSigners: 'list', enrolSigner: 'enrol', addSigner: 'add', revokeSigner: 'revoke', repairSigners: 'repair' } as const;
type Action = keyof typeof schemas;
type Result<A extends Action> = A extends keyof typeof SIGNER_METHODS ? Awaited<ReturnType<SignerKeyApplication[(typeof SIGNER_METHODS)[A]]>>
  : A extends keyof AgentCatalogApplication ? Awaited<ReturnType<AgentCatalogApplication[A]>> : never;
const revocationLog = (layout: Parameters<typeof localSignerKeyCustody>[0], keyFile: string) => new FileSignerRevocationLog(layout, () => openLocalIntegrityAuthority(layout, keyFile, false));
type ScopeContext = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
const storeOf = (context: ScopeContext) => async (access: 'read' | 'write') => openSqliteAgentCatalogStore(await context.path(), context.config.storage.sqlite,
  await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, access === 'write'), access);
/** S7 agent/skill catalog on the Core SQLite adapter. Reads never create a key, database or migration. Create, revise, import and every signer card
 * (S8-5) are a person's terminal card (the default card, AJAN-ORG S6): the MCP actor, or a caller without the terminal witness, is refused before
 * any read. Imports verify against the scope's `import` signer rows; AI/system writes sign through the host signer custody (never exported). */
const bind = <A extends Action>(action: A) => async (root: string, input: unknown, options: ConfigLoadOptions = {},
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }): Promise<Result<A>> => {
  try {
    const write = !action.startsWith('list') && !action.startsWith('inspect');
    if (write) await assertAuthorityWitness(`agents.${action}`, localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), witness);
    const parsed = schemas[action].parse(input), clock = new SystemTrustedClock();
    const context = await loadConfiguredScopeContext(root, parsed.scopeId, { ...options, heal: false }, write ? 'write' : 'read'), { layout, config } = context;
    const policy = new AgentCatalogPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
    const deps = { verifier: { verify: async () => context.principal }, authorize: policy.authorize.bind(policy),
      authorizeSigner: (...args: Parameters<typeof policy.authorize>) => policy.authorize(args[0], args[1], args[2], 'skill-signer'), openStore: storeOf(context),
      workClassIds: async () => registeredWorkClassIds(config.admission ? executionRegistrySchema.parse(config.admission.registry).workClasses : undefined),
      custody: localSignerKeyCustody(layout), revocations: revocationLog(layout, config.approvals.keyFile),
      promptCompositionMaxBytes: NATIVE_PROMPT_LIMITS.compositionMaxBytes, now: () => clock.sample().wallMs, eventId: randomUUID };
    const method = SIGNER_METHODS[action as keyof typeof SIGNER_METHODS];
    return await (method ? new SignerKeyApplication(deps)[method](parsed) : (new AgentCatalogApplication(deps) as unknown as Record<string, (input: unknown) => Promise<unknown>>)[action]!(parsed)) as Result<A>;
  } catch (error) { throw queryFailure(error); }
};
export const listConfiguredAgents = bind('listAgents'), inspectConfiguredAgent = bind('inspectAgent'), listConfiguredSkills = bind('listSkills'), inspectConfiguredSkill = bind('inspectSkill');
export const defineConfiguredAgent = bind('defineAgent'), defineConfiguredSkill = bind('defineSkill'), importConfiguredSkill = bind('importSkill');
export const listConfiguredSigners = bind('listSigners'), enrolConfiguredSigner = bind('enrolSigner'), addConfiguredSigner = bind('addSigner'), revokeConfiguredSigner = bind('revokeSigner'),
  repairConfiguredSigners = bind('repairSigners');
/** S8-5 at service start, before any work or signing: every logged revocation a (restored) scope ledger lacks is re-applied by the same revoke step.
 * A broken log is left for the person's repair card (all signing already refuses on it); any other failure holds the start. */
export async function replayConfiguredSignerRevocations(projectRoot: string, options: ConfigLoadOptions = {}): Promise<number> {
  try {
    const config = await loadComposedConfig(projectRoot, { ...options, heal: false }), log = revocationLog(config.productLayout, config.approvals.keyFile), clock = new SystemTrustedClock();
    let entries;
    try { entries = await log.list(); } catch (error) { if (error instanceof AgentCatalogStoreError && error.code === 'SIGNER_REVOCATION_LOG_BROKEN') return 0; throw error; }
    let revoked = 0;
    for (const scopeId of new Set(entries.map(entry => entry.scopeId))) {
      const context = await loadConfiguredScopeContext(projectRoot, scopeId, { ...options, heal: false }, 'write');
      revoked += await new SignerKeyApplication({ verifier: { verify: async () => context.principal }, authorize: async () => { throw new AgentCatalogStoreError('AGENT_CATALOG_UNAVAILABLE'); },
        openStore: storeOf(context), revocations: log, now: () => clock.sample().wallMs, eventId: randomUUID }).replay(scopeId);
    }
    return revoked;
  } catch (error) { throw queryFailure(error); }
}
