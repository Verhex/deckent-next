import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { AgentCatalogApplication, AgentCatalogPolicyAuthorization, AgentCatalogStoreError, AgentStandingApplication, SignerKeyApplication, registeredWorkClassIds, agentDefineCommandSchema as defineAgent,
  agentInspectQuerySchema as inspectAgent, agentListQuerySchema as listAgents, skillDefineCommandSchema as defineSkill, skillImportCommandSchema as importSkill,
  skillInspectQuerySchema as inspectSkill, skillListQuerySchema as listSkills, signerListQuerySchema as listSigners, signerEnrolCommandSchema as enrolSigner,
  signerAddCommandSchema as addSigner, signerRevokeCommandSchema as revokeSigner, signerRepairCommandSchema as repairSigners, suggestionListQuerySchema as listSuggestions,
  suggestionInspectQuerySchema as inspectSuggestion, standingChangeCommandSchema as changeStanding, suggestionDismissCommandSchema as dismissSuggestion,
  standingBulkCommandSchema as bulkStanding, revokedPromotionsQuerySchema as listRevokedPromotions, assertAuthorityWitness, type AgentCatalogDependencies, type AuthorityWitness } from '#engine/index.js';
import { executionRegistrySchema, type VerifiedPrincipal } from '#domain/index.js';
import { openSqliteAgentCatalogStore, openLocalIntegrityAuthority, attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, localSignerKeyCustody, FileSignerRevocationLog,
  NATIVE_PROMPT_LIMITS } from '#adapters/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { memoryJournalFor } from '#composition/core/memory/index.js';
const schemas = { listAgents, inspectAgent, listSkills, inspectSkill, defineAgent, defineSkill, importSkill, listSigners, enrolSigner, addSigner, revokeSigner, repairSigners,
  listSuggestions, inspectSuggestion, changeStanding, dismissSuggestion, bulkStanding, listRevokedPromotions };
/** S8-5 signer cards and S8-3/S8-4 standing and suggestion actions, and their application's method; every other action is the catalog application's. */
const SIGNER_METHODS = { listSigners: 'list', enrolSigner: 'enrol', addSigner: 'add', revokeSigner: 'revoke', repairSigners: 'repair' } as const;
const STANDING_METHODS = { listSuggestions: 'listSuggestions', inspectSuggestion: 'inspectSuggestion', changeStanding: 'change', dismissSuggestion: 'dismiss', bulkStanding: 'bulk',
  listRevokedPromotions: 'revokedPromotions' } as const;
type Action = keyof typeof schemas;
type Result<A extends Action> = A extends keyof typeof SIGNER_METHODS ? Awaited<ReturnType<SignerKeyApplication[(typeof SIGNER_METHODS)[A]]>>
  : A extends keyof typeof STANDING_METHODS ? Awaited<ReturnType<AgentStandingApplication[(typeof STANDING_METHODS)[A]]>>
  : A extends keyof AgentCatalogApplication ? Awaited<ReturnType<AgentCatalogApplication[A]>> : never;
const revocationLog = (layout: Parameters<typeof localSignerKeyCustody>[0], keyFile: string) => new FileSignerRevocationLog(layout, () => openLocalIntegrityAuthority(layout, keyFile, false));
export type ScopeContext = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
const storeOf = (context: ScopeContext) => async (access: 'read' | 'write') => openSqliteAgentCatalogStore(await context.path(), context.config.storage.sqlite,
  await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, access === 'write'), access);
/** S8-4 (N23): a lesson ref is readable when the reader's own memory `inspect` (the §7.4 source filter) returns that entry at the cited revision and digest. */
const lessonReadable = (context: ScopeContext): NonNullable<AgentCatalogDependencies['lessonReadable']> => async (principal, scopeId, refs) => {
  const journal = await memoryJournalFor({ ...context, principal }, 'read'), out: boolean[] = [];
  for (const ref of refs) {
    const shown = await journal.inspect({ schemaVersion: 1, scopeId, entryId: ref.entryId }).catch(() => null);
    out.push(shown?.status === 'ok' && shown.entry.revision === ref.revision && shown.entry.contentDigest === ref.contentDigest);
  }
  return out;
};
/** The catalog dependencies of one scope context under `principal` (default: the context's; the catalog aggregator passes its own workload identity). */
export function catalogDependencies(context: ScopeContext, principal: VerifiedPrincipal = context.principal): AgentCatalogDependencies {
  const { layout, config } = context, clock = new SystemTrustedClock(), policy = new AgentCatalogPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
  return { verifier: { verify: async () => principal }, authorize: policy.authorize.bind(policy),
    authorizeSigner: (action, scopeId, who) => policy.authorize(action, scopeId, who, undefined, 'skill-signer'), openStore: storeOf(context),
    workClassIds: async () => registeredWorkClassIds(config.admission ? executionRegistrySchema.parse(config.admission.registry).workClasses : undefined),
    custody: localSignerKeyCustody(layout), revocations: revocationLog(layout, config.approvals.keyFile), lessonReadable: lessonReadable(context),
    promptCompositionMaxBytes: NATIVE_PROMPT_LIMITS.compositionMaxBytes, now: () => clock.sample().wallMs, eventId: randomUUID };
}
const run = async <A extends Action>(root: string, action: A, input: unknown, options: ConfigLoadOptions, write: boolean): Promise<Result<A>> => {
  const parsed = schemas[action].parse(input), context = await loadConfiguredScopeContext(root, parsed.scopeId, { ...options, heal: false }, write ? 'write' : 'read'), deps = catalogDependencies(context);
  const signer = SIGNER_METHODS[action as keyof typeof SIGNER_METHODS], standing = STANDING_METHODS[action as keyof typeof STANDING_METHODS];
  const target = (signer ? new SignerKeyApplication(deps) : standing ? new AgentStandingApplication(deps) : new AgentCatalogApplication(deps)) as unknown as Record<string, (value: unknown) => Promise<unknown>>;
  return await target[signer ?? standing ?? action]!(parsed) as Result<A>;
};
const READS = new Set<Action>(['listAgents', 'inspectAgent', 'listSkills', 'inspectSkill', 'listSigners', 'listSuggestions', 'inspectSuggestion', 'listRevokedPromotions']);
/** S7 agent/skill catalog on the Core SQLite adapter. Reads never create a key, database or migration. Create, revise, import, every signer card (S8-5)
 * and every standing or suggestion card (S8-4) are a person's terminal card (the default card, AJAN-ORG S6): the MCP actor, or a caller without the
 * terminal witness, is refused before any read. Imports verify against the scope's `import` signer rows; AI/system writes sign through the host custody. */
const bind = <A extends Action>(action: A) => async (root: string, input: unknown, options: ConfigLoadOptions = {},
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }): Promise<Result<A>> => {
  try {
    const write = !READS.has(action);
    if (write) await assertAuthorityWitness(`agents.${action}`, localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), witness);
    return await run(root, action, input, options, write);
  } catch (error) { throw queryFailure(error); }
};
/**
 * S8-4 the signed AI command path (S8-DESIGN §8, §9; MCP): the MCP actor — never a person, who uses the terminal card — defines, imports or changes a
 * standing only signed (its enrolled host key through the signer service, or the `signed` its external key made) and only inside a policy grant; a
 * standing action needs a grant naming that WorkClass. Every signature is verified again in the catalog's commit transaction.
 */
const signedBind = <A extends 'defineAgent' | 'defineSkill' | 'importSkill' | 'changeStanding' | 'dismissSuggestion'>(action: A) =>
  async (root: string, input: unknown, options: ConfigLoadOptions = {}): Promise<Result<A>> => {
    try {
      // A person's write is a terminal card (`bind`); on this path only the MCP channel passes.
      if (localPrincipalChannel() !== 'mcp') await assertAuthorityWitness(`agents.${action}`, 'mcp', { attest: async () => false });
      return await run(root, action, input, options, true);
    } catch (error) { throw queryFailure(error); }
  };
export const listConfiguredAgents = bind('listAgents'), inspectConfiguredAgent = bind('inspectAgent'), listConfiguredSkills = bind('listSkills'), inspectConfiguredSkill = bind('inspectSkill');
export const defineConfiguredAgent = bind('defineAgent'), defineConfiguredSkill = bind('defineSkill'), importConfiguredSkill = bind('importSkill');
export const listConfiguredSigners = bind('listSigners'), enrolConfiguredSigner = bind('enrolSigner'), addConfiguredSigner = bind('addSigner'), revokeConfiguredSigner = bind('revokeSigner'),
  repairConfiguredSigners = bind('repairSigners');
export const listConfiguredSuggestions = bind('listSuggestions'), inspectConfiguredSuggestion = bind('inspectSuggestion'), changeConfiguredStanding = bind('changeStanding'),
  dismissConfiguredSuggestion = bind('dismissSuggestion'), bulkConfiguredStanding = bind('bulkStanding'), listConfiguredRevokedPromotions = bind('listRevokedPromotions');
export const signedDefineConfiguredAgent = signedBind('defineAgent'), signedDefineConfiguredSkill = signedBind('defineSkill'), signedImportConfiguredSkill = signedBind('importSkill'),
  signedChangeConfiguredStanding = signedBind('changeStanding'), signedDismissConfiguredSuggestion = signedBind('dismissSuggestion');
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
