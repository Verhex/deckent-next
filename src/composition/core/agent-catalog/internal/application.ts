import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { AgentCatalogApplication, AgentCatalogPolicyAuthorization, registeredWorkClassIds, agentDefineCommandSchema as defineAgent, agentInspectQuerySchema as inspectAgent,
  agentListQuerySchema as listAgents, skillDefineCommandSchema as defineSkill, skillImportCommandSchema as importSkill, skillInspectQuerySchema as inspectSkill,
  skillListQuerySchema as listSkills, assertAuthorityWitness, type AuthorityWitness } from '#engine/index.js';
import { executionRegistrySchema } from '#domain/index.js';
import { openSqliteAgentCatalogStore, openLocalIntegrityAuthority, attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, NATIVE_PROMPT_LIMITS } from '#adapters/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
const schemas = { listAgents, inspectAgent, listSkills, inspectSkill, defineAgent, defineSkill, importSkill };
/** S7 agent/skill catalog on the Core SQLite adapter. Reads never create a key, database or migration. Create, revise and import are a person's
 * terminal card (the default card, AJAN-ORG S6): the MCP actor, or a caller without the terminal witness, is refused before any read. Core wires
 * no skill-signature trust, so every import fails closed at floor (d) until a hub/Enterprise adapter supplies trust anchors. */
const bind = <A extends keyof typeof schemas>(action: A) => async (root: string, input: unknown, options: ConfigLoadOptions = {},
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }): Promise<Awaited<ReturnType<AgentCatalogApplication[A]>>> => {
  try {
    const write = action.startsWith('define') || action === 'importSkill';
    if (write) await assertAuthorityWitness(`agents.${action}`, localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), witness);
    const parsed = schemas[action].parse(input), clock = new SystemTrustedClock();
    const context = await loadConfiguredScopeContext(root, parsed.scopeId, { ...options, heal: false }, write ? 'write' : 'read'), { layout, config } = context;
    const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
    return await new AgentCatalogApplication({ verifier: { verify: async () => context.principal }, authorize: (...args) => new AgentCatalogPolicyAuthorization(source).authorize(...args),
      openStore: async access => openSqliteAgentCatalogStore(await context.path(), config.storage.sqlite, await openLocalIntegrityAuthority(layout, config.approvals.keyFile, access === 'write'), access),
      workClassIds: async () => registeredWorkClassIds(config.admission ? executionRegistrySchema.parse(config.admission.registry).workClasses : undefined),
      promptCompositionMaxBytes: NATIVE_PROMPT_LIMITS.compositionMaxBytes, now: () => clock.sample().wallMs, eventId: randomUUID })[action](parsed) as Awaited<ReturnType<AgentCatalogApplication[A]>>;
  } catch (error) { throw queryFailure(error); }
};
export const listConfiguredAgents = bind('listAgents'), inspectConfiguredAgent = bind('inspectAgent'), listConfiguredSkills = bind('listSkills'), inspectConfiguredSkill = bind('inspectSkill');
export const defineConfiguredAgent = bind('defineAgent'), defineConfiguredSkill = bind('defineSkill'), importConfiguredSkill = bind('importSkill');
