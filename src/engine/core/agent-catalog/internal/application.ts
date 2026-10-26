import { skillContentV2Digest } from '#engine/core/hub/index.js';
import { hubSkillContentSchema, hubSkillDefinitionSchema, defineAgentRevision, defineSkillRevision, initialAgentStandings, isAiPrincipal, requireActionSigner, requireSkillImportPinnedAndSigned, AgentCatalogError, AGENT_CATALOG_LIMITS,
  type AgentDefinition, type AgentStanding, type AuditEvent, type CatalogSignature, type ReadableSkillDefinition, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { authenticate } from '#engine/core/authentication/index.js';
import { agentDefineCommandSchema, agentInspectQuerySchema, agentListQuerySchema, skillDefineCommandSchema, skillImportCommandSchema, skillInspectQuerySchema,
  skillListQuerySchema, AgentCatalogStoreError, type AgentCatalogAction, type AgentCatalogDependencies, type AgentCatalogMutation, type AgentCatalogStore,
  type AgentInspection, type AgentListing, type SignedCatalogAction, type SkillInspection, type SkillListing, type AgentCatalogChange } from './contract.js';
import { catalogSuggestionAuditSubject, catalogSuggestionProducerKey, catalogSuggestionStateSchema, requireCatalogSuggestionDecidable } from './suggestions.js';
import { catalogCommandDigest, personaDigest, skillContentDigest, skillSetDigest } from './digests.js';
import { agentPromptBytes, agentPromptParts } from './selection.js';
import { signCatalogActions } from './signing.js';

type Item = AgentDefinition | ReadableSkillDefinition;
const inScope = <T extends Item>(item: T, scopeId: string): T => { if (item.scopeId !== scopeId) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT'); return item; };
const idOf = (item: Item) => 'agentId' in item ? item.agentId : item.skillId;

/** Sole owner of agent/skill catalog transitions (one writer per scope through the store's compare-and-set and receipts). Nothing deletes. */
export class AgentCatalogApplication {
  constructor(private readonly deps: AgentCatalogDependencies) {}
  private async admit(action: AgentCatalogAction, scopeId: string, credential?: unknown) {
    const principal = await authenticate(this.deps.verifier, credential, scopeId);
    return { principal, authorization: await this.deps.authorize(action, scopeId, principal) };
  }
  private async read<T>(scopeId: string, credential: unknown, work: (store: AgentCatalogStore) => Promise<T>): Promise<T> {
    await this.admit('inspect', scopeId, credential);
    const store = await this.deps.openStore('read');
    try { return await work(store); } finally { store.close(); }
  }
  private async inspect<T extends Item, X extends object = object>(scopeId: string, id: string, credential: unknown, load: (store: AgentCatalogStore) => Promise<T | null>,
    history: (store: AgentCatalogStore) => Promise<readonly T[]>, extra: (store: AgentCatalogStore, item: T) => Promise<X> = async () => ({}) as X) {
    return this.read(scopeId, credential, async store => {
      const item = await load(store);
      if (!item) return { schemaVersion: 1 as const, status: 'not-found' as const, id };
      const rows = (await history(store)).map(row => inScope(row, scopeId));
      if (idOf(inScope(item, scopeId)) !== id || rows.at(-1)?.revision !== item.revision) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
      // S8-5 (owner Q-S13): the state of every key that signed a shown revision, so a surface marks rows whose signer was revoked.
      const signers: Record<string, 'active' | 'revoked'> = {};
      for (const keyId of new Set([item, ...rows].flatMap(row => row.provenance.signed ? [row.provenance.signed.keyId] : [])))
        signers[keyId] = (await store.signer(scopeId, keyId))?.state ?? 'revoked';
      return { schemaVersion: 1 as const, status: 'ok' as const, item, history: rows, signers, ...(store.upstream ? { upstream: await store.upstream(scopeId, 'agentId' in item ? 'agent' : 'skill', id, item.revision, this.deps.now(), undefined,
        (this.deps.revocations ? await this.deps.revocations.list() : []).filter(row => row.scopeId === scopeId).map(row => row.keyId)) } : {}), ...await extra(store, item) };
    });
  }
  async listAgents(input: unknown, credential?: unknown): Promise<AgentListing> {
    const query = agentListQuerySchema.parse(input);
    return this.read(query.scopeId, credential, async store => ({ schemaVersion: 1 as const, scopeId: query.scopeId,
      items: (await store.listAgents(query.scopeId, query.limit)).slice(0, query.limit).map(row => inScope(row, query.scopeId)) }));
  }
  async inspectAgent(input: unknown, credential?: unknown): Promise<AgentInspection> {
    const query = agentInspectQuerySchema.parse(input), max = AGENT_CATALOG_LIMITS.historyMax;
    return this.inspect(query.scopeId, query.agentId, credential, store => store.loadAgent(query.scopeId, query.agentId), store => store.agentHistory(query.scopeId, query.agentId, max),
      async (store, item) => ({ standings: await this.standingsOf(store, item) }));
  }
  async listSkills(input: unknown, credential?: unknown): Promise<SkillListing> {
    const query = skillListQuerySchema.parse(input);
    return this.read(query.scopeId, credential, async store => ({ schemaVersion: 1 as const, scopeId: query.scopeId,
      items: (await store.listSkills(query.scopeId, query.limit)).slice(0, query.limit).map(row => inScope(row, query.scopeId)) }));
  }
  async inspectSkill(input: unknown, credential?: unknown): Promise<SkillInspection> {
    const query = skillInspectQuerySchema.parse(input), max = AGENT_CATALOG_LIMITS.historyMax;
    return this.inspect(query.scopeId, query.skillId, credential, store => store.loadSkill(query.scopeId, query.skillId), store => store.skillHistory(query.scopeId, query.skillId, max));
  }
  /** Create (expectedRevision null) or revise an agent. Skill refs must be exact pinned revisions of this scope; WorkClass ids must be registered.
   * The org tree is not pre-checked here: the store checks it inside its write transaction, against the rows it holds at commit. */
  async defineAgent(input: unknown, credential?: unknown, hubUpdate?: { readonly carryStanding: boolean }): Promise<AgentCatalogMutation<AgentDefinition>> {
    const command = { ...agentDefineCommandSchema.parse(input), ...(hubUpdate ? { hubUpdate } : {}) }, { principal, authorization } = await this.admit('define', command.scopeId, credential);
    return this.mutate('agent', command, command.agentId, principal, authorization.revision, async (store, previous, signed) => {
      const classes = this.deps.workClassIds ? await this.deps.workClassIds(command.scopeId) : null;
      if (classes && command.content.workClasses.some(id => !classes.includes(id))) throw new AgentCatalogError('AGENT_WORK_CLASS_UNKNOWN');
      const skills: ReadableSkillDefinition[] = [];
      for (const ref of command.content.skills) {
        const skill = await store.loadSkill(command.scopeId, ref.skillId, ref.revision);
        if (!skill || inScope(skill, command.scopeId).skillId !== ref.skillId || skill.revision !== ref.revision || skill.contentDigest !== ref.digest) throw new AgentCatalogError('AGENT_SKILL_NOT_PINNED');
        skills.push(skill);
      }
      const decided = await this.decide(store, command, principal, previous as AgentDefinition | null, command.content.workClasses);
      const item = defineAgentRevision(previous as AgentDefinition | null, { scopeId: command.scopeId, agentId: command.agentId, commandId: command.commandId, content: command.content,
        personaDigest: personaDigest(command.content.persona), skillSetDigest: skillSetDigest(command.content.skills), author: principal, atMs: this.deps.now(), signed, origin: decided.origin });
      // S8-1a (§5, N16): persona + pinned skills must leave the reserved task budget of the worker prompt bound, checked here and again at admission.
      const bound = this.deps.promptCompositionMaxBytes;
      if (bound !== undefined && agentPromptBytes(agentPromptParts(item, skills)) > bound - AGENT_CATALOG_LIMITS.promptReservedTaskBytes) throw new AgentCatalogError('AGENT_PROMPT_TOO_LARGE');
      const prior = previous as AgentDefinition | null, kept = new Set(prior?.content.skills.map(ref => JSON.stringify(ref)) ?? []);
      // Q-S6: inheritance needs the same skill set or local-only added/changed skills (an imported one always restarts at candidate).
      const importChanged = skills.some(skill => skill.source.kind === 'import' && !kept.has(JSON.stringify({ skillId: skill.skillId, revision: skill.revision, digest: skill.contentDigest })));
      return { item, standings: initialAgentStandings(item, prior && (!hubUpdate || hubUpdate.carryStanding) ? { definition: prior, standings: await store.standings(command.scopeId, prior.agentId, prior.revision) } : null, importChanged && !hubUpdate?.carryStanding, hubUpdate?.carryStanding === true),
        suggestion: decided.suggestion };
    }) as Promise<AgentCatalogMutation<AgentDefinition>>;
  }
  /** A person's own skill text (source local, unsigned, pinned by its content digest). Import from elsewhere goes through `importSkill` only. */
  async defineSkill(input: unknown, credential?: unknown): Promise<AgentCatalogMutation<ReadableSkillDefinition>> {
    const command = skillDefineCommandSchema.parse(input), { principal, authorization } = await this.admit('define', command.scopeId, credential);
    return this.mutate('skill', command, command.skillId, principal, authorization.revision, async (store, previous, signed) => {
      const decided = await this.decide(store, command, principal, null, null);
      return { item: defineSkillRevision(previous as ReadableSkillDefinition | null, { scopeId: command.scopeId, skillId: command.skillId, commandId: command.commandId, content: command.content,
        contentDigest: skillContentDigest(command.content), source: { kind: 'local' }, signature: { status: 'unsigned' }, author: principal, atMs: this.deps.now(), signed, origin: decided.origin }),
      suggestion: decided.suggestion };
    }) as Promise<AgentCatalogMutation<ReadableSkillDefinition>>;
  }
  /** Floor (d) for every principal and whatever policy allows: pinned by the digest of the received bytes and signed over (id, digest) by a key the
   * person registered for `import` — verified by the store inside the write transaction (S8-5), so a key revoked before commit refuses the import. */
  async importSkill(input: unknown, credential?: unknown): Promise<AgentCatalogMutation<ReadableSkillDefinition>> {
    const command = skillImportCommandSchema.parse(input), { principal, authorization } = await this.admit('import', command.scopeId, credential);
    const contentDigest = skillContentDigest(command.content);
    requireSkillImportPinnedAndSigned({ declaredDigest: command.pin, computedDigest: contentDigest, signature: command.signature });
    const signature = command.signature!;
    return this.mutate('skill', command, command.skillId, principal, authorization.revision, async (_store, previous, signed) => ({ item: defineSkillRevision(previous as ReadableSkillDefinition | null, {
      scopeId: command.scopeId, skillId: command.skillId, commandId: command.commandId, content: command.content, contentDigest, signed,
      source: { kind: 'import', ref: command.source.ref }, signature: { status: 'verified', ...signature }, author: principal, atMs: this.deps.now() }) }), 'import') as Promise<AgentCatalogMutation<ReadableSkillDefinition>>;
  }
  /** H2: v2 import uses the same floor, authorization, action signing, receipt and catalog commit as v1. */
  async importHubSkill(input: unknown, credential?: unknown): Promise<AgentCatalogMutation<ReadableSkillDefinition>> {
    const command = skillImportCommandSchema.extend({ content: hubSkillContentSchema }).parse(input);
    const { principal, authorization } = await this.admit('import', command.scopeId, credential), contentDigest = skillContentV2Digest(command.content);
    requireSkillImportPinnedAndSigned({ declaredDigest: command.pin, computedDigest: contentDigest, signature: command.signature });
    return this.mutate('skill', command, command.skillId, principal, authorization.revision, async (_store, previous, signed) => ({
      item: hubSkillDefinitionSchema.parse({ schemaVersion: 2, scopeId: command.scopeId, skillId: command.skillId, revision: (previous?.revision ?? 0) + 1,
        content: command.content, contentDigest, source: { kind: 'import', ref: command.source.ref }, signature: { status: 'verified', ...command.signature! },
        provenance: { author: { issuer: principal.issuer, subject: principal.subject, ai: isAiPrincipal(principal) }, commandId: command.commandId,
          definedAtMs: this.deps.now(), ...(signed ? { signed } : {}) } }) }), 'import') as Promise<AgentCatalogMutation<ReadableSkillDefinition>>;
  }
  /** S8-5: an AI/system write is signed over the `catalog-action:1` bytes built here from the typed command (`signCatalogActions`); a person's carries none. */
  private async sign(store: AgentCatalogStore, kind: 'agent' | 'skill', action: 'define' | 'import', command: { scopeId: string; commandId: string; expectedRevision: number | null;
    signed?: CatalogSignature | undefined }, itemId: string, revision: number, digest: string, principal: VerifiedPrincipal): Promise<SignedCatalogAction | undefined> {
    return (await signCatalogActions(this.deps, store, principal, command.scopeId, [{ scopeId: command.scopeId, action, target: { kind, id: itemId, revision },
      expectedRevision: command.expectedRevision, contentDigest: digest, toStanding: null, suggestionId: null, commandId: command.commandId,
      principal: { issuer: principal.issuer, subject: principal.subject } }], command.signed))[0];
  }
  /**
   * S8-4 define from a suggestion (§6 fold A; a person's card only — the draft is rendered at card time under their read filter and never stored): the
   * suggestion must pass the shared validity check (`requireCatalogSuggestionDecidable`: open, live, unexpired, producer key active) and be of a kind this define decides — a skill from `propose-skill` (origin `lessons-derived`: AI
   * output, N36), an agent from `propose-agent` (binding its WorkClass) or the next revision of the agent a `revise-agent` names. Decided in this commit.
   */
  private async decide(store: AgentCatalogStore, command: { scopeId: string; commandId: string; fromSuggestion?: string | undefined }, principal: VerifiedPrincipal,
    previous: AgentDefinition | null, workClasses: readonly string[] | null) {
    if (!command.fromSuggestion) return {};
    if (isAiPrincipal(principal)) throw new AgentCatalogError('AGENT_STANDING_REFUSED');
    const found = await store.suggestion(command.scopeId, command.fromSuggestion), at = this.deps.now();
    if (!found) throw new AgentCatalogStoreError('AGENT_CATALOG_NOT_FOUND');
    const { record, state } = found, key = record.key, p = record.proposed;
    if (record.scopeId !== command.scopeId) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
    requireCatalogSuggestionDecidable(found, at, await catalogSuggestionProducerKey(store, found));
    const fits = workClasses === null ? record.kind === 'propose-skill' : record.kind === 'propose-agent' ? key.kind === 'work-class' && workClasses.includes(key.workClass)
      : record.kind === 'revise-agent' && key.kind === 'agent' && previous !== null && key.agentId === previous.agentId && key.revision === previous.revision;
    if (!fits) throw new AgentCatalogError('CATALOG_SUGGESTION_STALE');
    const origin = p.kind === 'skill-draft' ? { kind: 'lessons-derived' as const, suggestionId: record.suggestionId, template: p.template, lessonSetDigest: p.lessonSetDigest }
      : p.kind === 'agent-draft' ? { kind: 'template' as const, suggestionId: record.suggestionId, template: p.template, lessonSetDigest: null } : undefined;
    const next = catalogSuggestionStateSchema.parse({ schemaVersion: 1, scopeId: record.scopeId, suggestionId: record.suggestionId, state: 'decided', revision: state.revision + 1,
      by: { issuer: principal.issuer, subject: principal.subject, ai: false }, atMs: at, commandId: command.commandId, decision: 'define', supersededBy: null });
    return { origin, suggestion: { previous: state, next, record } };
  }
  /** The current revision's standings, each checked against the row it belongs to (scope, agent, revision, a bound WorkClass). */
  private async standingsOf(store: AgentCatalogStore, item: AgentDefinition): Promise<readonly AgentStanding[]> {
    const rows = await store.standings(item.scopeId, item.agentId, item.revision);
    if (rows.some(row => row.scopeId !== item.scopeId || row.agentId !== item.agentId || row.revision !== item.revision || !item.content.workClasses.includes(row.workClass))) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
    return rows;
  }
  private async mutate(kind: 'agent' | 'skill', command: { scopeId: string; commandId: string; expectedRevision: number | null; signed?: CatalogSignature | undefined }, itemId: string,
    principal: VerifiedPrincipal, policyRevision: string, next: (store: AgentCatalogStore, previous: Item | null, signed: { keyId: string; signatureDigest: string } | undefined) =>
      Promise<{ item: Item; standings?: readonly AgentStanding[]; suggestion?: AgentCatalogChange['suggestion'] }>, action: 'define' | 'import' = 'define'): Promise<AgentCatalogMutation<Item>> {
    const digest = catalogCommandDigest(kind, command, principal);
    const store = await this.deps.openStore('write');
    try {
      const replay = await store.receipt(command.scopeId, command.commandId);
      if (replay) {
        const item = replay.digest === digest && replay.kind === kind && replay.itemId === itemId ? await (kind === 'agent' ? store.loadAgent(command.scopeId, itemId, replay.revision)
          : store.loadSkill(command.scopeId, itemId, replay.revision)) : null;
        if (!item) throw new AgentCatalogStoreError('AGENT_CATALOG_COMMAND_CONFLICT');
        // N38: a replayed signed command answers only while its key is still active; the committed row itself stays (owner Q-S13).
        const keyId = item.provenance.signed?.keyId;
        if (keyId) requireActionSigner(await store.signer(command.scopeId, keyId), command.scopeId, principal);
        return { schemaVersion: 1, replayed: true, item: inScope(item, command.scopeId) };
      }
      const previous = await (kind === 'agent' ? store.loadAgent(command.scopeId, itemId) : store.loadSkill(command.scopeId, itemId));
      if (command.expectedRevision === null && previous) throw new AgentCatalogStoreError('AGENT_CATALOG_EXISTS');
      if (command.expectedRevision !== null && !previous) throw new AgentCatalogStoreError('AGENT_CATALOG_NOT_FOUND');
      if (previous && inScope(previous, command.scopeId).revision !== command.expectedRevision) throw new AgentCatalogStoreError('AGENT_CATALOG_REVISION_CONFLICT');
      const signed = await this.sign(store, kind, action, command, itemId, (previous?.revision ?? 0) + 1, digest, principal);
      const mark = signed && { keyId: signed.keyId, signatureDigest: sha256(signed.signature) };
      const { item, standings = [], suggestion } = await next(store, previous, mark);
      const contentDigest = 'agentId' in item ? item.personaDigest : item.contentDigest;
      const event: AuditEvent = { schemaVersion: 1, eventId: this.deps.eventId(), scopeId: command.scopeId, principal: { issuer: principal.issuer, subject: principal.subject },
        policyRevision, atMs: item.provenance.definedAtMs, subject: { kind: 'agent-catalog', item: kind, action, id: itemId, commandId: command.commandId, revision: item.revision,
          contentDigest, skillSetDigest: 'agentId' in item ? item.skillSetDigest : null, ...(mark ? { signed: mark } : {}) } };
      const decided = suggestion && { ...suggestion, event: { ...event, eventId: this.deps.eventId(), atMs: suggestion.next.atMs, subject: catalogSuggestionAuditSubject(suggestion.record, 'decide', suggestion.next) } };
      const receipt = { scopeId: command.scopeId, commandId: command.commandId, kind, itemId, revision: item.revision, digest }, seal = { ...(signed ? { signed } : {}), ...(decided ? { suggestion: decided } : {}) };
      const saved = await store.commit(kind === 'agent' ? { kind, previous: previous as AgentDefinition | null, next: item as AgentDefinition, receipt, event, standings, ...seal }
        : { kind, previous: previous as ReadableSkillDefinition | null, next: item as ReadableSkillDefinition, receipt, event, ...seal });
      return { schemaVersion: 1, replayed: saved.replayed, item: saved.item };
    } finally { store.close(); }
  }
}
