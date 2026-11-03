import { randomUUID } from 'node:crypto';
import { AgentCatalogApplication, AgentStandingApplication, CATALOG_EVOLUTION_PASS_MODES, assertAuthorityWitness, catalogAggregatorFor, catalogDraftDigest, catalogDraftMinLessons,
  catalogEvolutionRegistryAvailable, renderCatalogDraft, suggestionInspectQuerySchema,
  type AuthorityWitness, type CatalogDraft, type CatalogSuggestion, type CatalogSuggestionView } from '#engine/index.js';
import { AGENT_CATALOG_LIMITS, catalogIdSchema, clientCommandIdSchema, counterSchema, type MemoryEntry } from '#domain/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { memoryJournalFor } from '#composition/core/memory/index.js';
import { catalogDependencies, type ScopeContext } from './application.js';

export type ConfiguredCatalogDraft = Readonly<{ schemaVersion: 1; suggestion: CatalogSuggestionView; draft: CatalogDraft; digest: string; readable: number; withheld: number; aiDerived: boolean }>;
const witnessOf = (operation: string, witness: AuthorityWitness) => assertAuthorityWitness(operation, localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), witness);
/** Person-card-only, never stored: draft from readable pinned lessons above minLessons; hidden refs only count, a skill draft is AI output. */
async function render(context: ScopeContext, scopeId: string, suggestionId: string): Promise<ConfiguredCatalogDraft> {
  const shown = await new AgentStandingApplication(catalogDependencies(context)).inspectSuggestion({ schemaVersion: 1, scopeId, suggestionId });
  if (shown.status !== 'ok') throw ErrorRegistry.createError('AGENT_CATALOG_NOT_FOUND');
  const view = shown.item, p = view.proposed;
  if (view.mode !== 'on') throw ErrorRegistry.createError('CATALOG_SUGGESTION_SHADOW');
  if (view.state !== 'open' || (view.kind !== 'propose-agent' && view.kind !== 'propose-skill')) throw ErrorRegistry.createError('CATALOG_SUGGESTION_STALE');
  const entries: MemoryEntry[] = [];
  if (p.kind === 'skill-draft') {
    const journal = await memoryJournalFor(context, 'read');
    for (const ref of p.lessons) { const read = await journal.inspect({ schemaVersion: 1, scopeId, entryId: ref.entryId }).catch(() => null); if (read?.status === 'ok') entries.push(read.entry); }
    const minimum = catalogDraftMinLessons(context.config.catalogEvolution.overlay);
    if (minimum === null || entries.length < minimum) throw ErrorRegistry.createError('CATALOG_DRAFT_UNAVAILABLE');
  }
  const record = { ...view, proposed: p.kind === 'skill-draft' ? { kind: p.kind, template: p.template, lessons: p.lessons, lessonSetDigest: p.lessonSetDigest } : p } as unknown as CatalogSuggestion;
  const draft = renderCatalogDraft(record, entries);
  if (!draft) throw ErrorRegistry.createError('CATALOG_DRAFT_UNAVAILABLE');
  return { schemaVersion: 1, suggestion: view, draft, digest: catalogDraftDigest(draft), readable: entries.length,
    withheld: 'withheld' in p ? p.withheld : 0, aiDerived: view.kind === 'propose-skill' };
}
export async function draftConfiguredSuggestion(root: string, input: unknown, options: ConfigLoadOptions = {},
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }): Promise<ConfiguredCatalogDraft> {
  try {
    await witnessOf('agents.draft', witness);
    const query = suggestionInspectQuerySchema.parse(input);
    return await render(await loadConfiguredScopeContext(root, query.scopeId, { ...options, heal: false }, 'read'), query.scopeId, query.suggestionId);
  } catch (error) { throw queryFailure(error); }
}
const defineInput = suggestionInspectQuerySchema.extend({ id: catalogIdSchema, expectedRevision: counterSchema.positive().nullable(), draftDigest: suggestionInspectQuerySchema.shape.suggestionId,
  commandId: clientCommandIdSchema.optional() }).strict();
/** Re-render at apply and compare the card digest; define settles the suggestion atomically and names it in origin. */
export async function defineConfiguredFromSuggestion(root: string, input: unknown, options: ConfigLoadOptions = {},
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }) {
  try {
    await witnessOf('agents.defineFromSuggestion', witness);
    const command = defineInput.parse(input), context = await loadConfiguredScopeContext(root, command.scopeId, { ...options, heal: false }, 'write');
    const rendered = await render(context, command.scopeId, command.suggestionId);
    if (rendered.digest !== command.draftDigest) throw ErrorRegistry.createError('CATALOG_DRAFT_CHANGED');
    const catalog = new AgentCatalogApplication(catalogDependencies(context)), base = { schemaVersion: 1 as const, scopeId: command.scopeId, commandId: command.commandId ?? randomUUID(),
      expectedRevision: command.expectedRevision, fromSuggestion: command.suggestionId };
    return rendered.draft.kind === 'agent' ? await catalog.defineAgent({ ...base, agentId: command.id, content: rendered.draft.content })
      : await catalog.defineSkill({ ...base, skillId: command.id, content: rendered.draft.content });
  } catch (error) { throw queryFailure(error); }
}
/** Soft viewer-scoped monitor: open suggestions, revoked-key promotions, missing aggregator key and unusable registry. */
export async function inspectConfiguredCatalogMonitor(root: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<readonly string[]> {
  const context = await loadConfiguredScopeContext(root, scopeId, { ...options, heal: false }, 'read'), out: string[] = [], mode = context.config.catalogEvolution.mode;
  if (!catalogEvolutionRegistryAvailable(context.config.catalogEvolution.overlay)) out.push('catalog-evolution-registry-unavailable');
  const viewer = new AgentStandingApplication(catalogDependencies(context)), soft = <T>(work: Promise<T>) => work.catch(() => null);
  if ((CATALOG_EVOLUTION_PASS_MODES as readonly string[]).includes(mode) && !await soft(new AgentStandingApplication(catalogDependencies(context, catalogAggregatorFor(context.principal, scopeId))).ready(scopeId))) {
    const principal = catalogAggregatorFor(context.principal, scopeId);
    out.push(`catalog-aggregator-unsigned:${JSON.stringify([scopeId, principal.issuer, principal.subject])}`);
  }
  const open = (await soft(viewer.listSuggestions({ schemaVersion: 1, scopeId, open: true, limit: AGENT_CATALOG_LIMITS.pageMax })))?.items.filter(row => row.state === 'open' && row.mode === 'on').length;
  if (open) out.push(`catalog-suggestions-open:${open}`);
  const revoked = (await soft(viewer.revokedPromotions({ schemaVersion: 1, scopeId })))?.length;
  if (revoked) out.push(`catalog-signer-revoked:${revoked}`);
  return out;
}
