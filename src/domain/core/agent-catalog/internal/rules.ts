import { isAiPrincipal } from '#domain/core/principal/index.js';
import { AgentCatalogError, agentContentSchema, agentDefinitionSchema, skillContentSchema, skillDefinitionSchema, skillSourceSchema,
  type AgentDefinition, type SkillDefinition, type SkillSignature, type SkillSignatureVerdict } from './contract.js';

interface Actor { readonly issuer: string; readonly subject: string; readonly assurance?: string }
const who = (actor: Actor) => ({ issuer: actor.issuer, subject: actor.subject, ai: isAiPrincipal(actor) });
type Signed = { readonly keyId: string; readonly signatureDigest: string } | undefined;
type Origin = { readonly kind: 'lessons-derived' | 'template'; readonly suggestionId: string; readonly template: string; readonly lessonSetDigest: string | null } | undefined;
const provenance = (author: Actor, commandId: string, definedAtMs: number, signed: Signed, origin?: Origin) => ({ author: who(author), commandId, definedAtMs, ...(signed ? { signed } : {}), ...(origin ? { origin } : {}) });
const next = <T extends { scopeId: string; revision: number }>(previous: T | null, scopeId: string, id: string, previousId: string | undefined) => {
  if (previous && (previous.scopeId !== scopeId || previousId !== id)) return null;
  return (previous?.revision ?? 0) + 1;
};

/** A new agent (revision 1) or the next revision of `previous`. Digests are the engine's (the domain stays free of hashing). */
export function defineAgentRevision(previous: AgentDefinition | null, input: { readonly scopeId: string; readonly agentId: string; readonly commandId: string;
  readonly content: unknown; readonly personaDigest: string; readonly skillSetDigest: string; readonly author: Actor; readonly atMs: number; readonly signed?: Signed; readonly origin?: Origin }): AgentDefinition {
  const content = agentContentSchema.safeParse(input.content), revision = next(previous, input.scopeId, input.agentId, previous?.agentId);
  if (!content.success || revision === null) throw new AgentCatalogError('AGENT_DEFINITION_INVALID');
  if (content.data.parentAgentId === input.agentId) throw new AgentCatalogError('AGENT_ORG_CYCLE');
  const row = agentDefinitionSchema.safeParse({ schemaVersion: 1, scopeId: input.scopeId, agentId: input.agentId, revision, content: content.data,
    personaDigest: input.personaDigest, skillSetDigest: input.skillSetDigest, tier: null, provenance: provenance(input.author, input.commandId, input.atMs, input.signed, input.origin) });
  if (!row.success) throw new AgentCatalogError('AGENT_DEFINITION_INVALID');
  return row.data;
}

/** A new skill or its next revision. `signature` is `unsigned` for a person's local text, `verified` only after the import floor passed. */
export function defineSkillRevision(previous: Pick<SkillDefinition, 'scopeId' | 'skillId' | 'revision'> | null, input: { readonly scopeId: string; readonly skillId: string; readonly commandId: string;
  readonly content: unknown; readonly contentDigest: string; readonly source: unknown; readonly author: Actor; readonly atMs: number; readonly signed?: Signed; readonly origin?: Origin;
  readonly signature: { readonly status: 'unsigned' } | ({ readonly status: 'verified' } & SkillSignature) }): SkillDefinition {
  const content = skillContentSchema.safeParse(input.content), source = skillSourceSchema.safeParse(input.source);
  const revision = next(previous, input.scopeId, input.skillId, previous?.skillId);
  if (!content.success || !source.success || revision === null) throw new AgentCatalogError('SKILL_DEFINITION_INVALID');
  const row = skillDefinitionSchema.safeParse({ schemaVersion: 1, scopeId: input.scopeId, skillId: input.skillId, revision, content: content.data,
    contentDigest: input.contentDigest, source: source.data, signature: input.signature, provenance: provenance(input.author, input.commandId, input.atMs, input.signed, input.origin) });
  if (!row.success) throw new AgentCatalogError('SKILL_DEFINITION_INVALID');
  return row.data;
}

/**
 * The whole org tree of one scope after a change (agent id → manager id): every manager exists, no agent reports to itself through any chain, and no
 * chain is deeper than `maxDepth` (a root is depth 1). Any violation refuses the change; the store runs this inside its write transaction.
 */
export function checkAgentOrgTree(nodes: ReadonlyMap<string, string | null>, maxDepth: number): void {
  let tooDeep = false;
  for (const start of nodes.keys()) {
    const path = new Set<string>();
    for (let id: string | null = start; id !== null; id = nodes.get(id) ?? null) {
      if (path.has(id)) throw new AgentCatalogError('AGENT_ORG_CYCLE');
      if (!nodes.has(id)) throw new AgentCatalogError('AGENT_PARENT_NOT_FOUND');
      path.add(id);
    }
    if (path.size > maxDepth) tooDeep = true;
  }
  if (tooDeep) throw new AgentCatalogError('AGENT_ORG_DEPTH');
}

/**
 * Hard floor (d), AJAN-ORG 2026-10-16 S1: an unpinned or unsigned skill is never imported, for any principal. Versioned code with no principal,
 * policy or configuration input, so no grant or setting can relax it (e). The pin is the publisher's declared digest compared with the digest the
 * engine computed from the received bytes; it is never trusted from the declaration alone. Runs before any signature check.
 */
export function requireSkillImportPinnedAndSigned(input: { readonly declaredDigest: string | null; readonly computedDigest: string; readonly signature: SkillSignature | null }): void {
  if (input.declaredDigest === null) throw new AgentCatalogError('SKILL_IMPORT_UNPINNED');
  if (input.declaredDigest !== input.computedDigest) throw new AgentCatalogError('SKILL_IMPORT_PIN_MISMATCH');
  if (input.signature === null) throw new AgentCatalogError('SKILL_IMPORT_UNSIGNED');
}
/** The second half of floor (d): only a `valid` verdict over exactly (skill id, content digest) admits the import. */
export function requireSkillSignatureVerified(verdict: SkillSignatureVerdict): void {
  if (verdict !== 'valid') throw new AgentCatalogError('SKILL_IMPORT_SIGNATURE_UNVERIFIED');
}
