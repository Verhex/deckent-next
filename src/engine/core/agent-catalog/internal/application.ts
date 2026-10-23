import { encodeCommandProjection, defineAgentRevision, defineSkillRevision, initialAgentStandings, requireSkillImportPinnedAndSigned, requireSkillSignatureVerified, AgentCatalogError,
  AGENT_CATALOG_LIMITS, type AgentDefinition, type AgentStanding, type AuditEvent, type SkillDefinition, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { authenticate } from '#engine/core/authentication/index.js';
import { agentDefineCommandSchema, agentInspectQuerySchema, agentListQuerySchema, skillDefineCommandSchema, skillImportCommandSchema, skillInspectQuerySchema,
  skillListQuerySchema, AgentCatalogStoreError, type AgentCatalogAction, type AgentCatalogDependencies, type AgentCatalogMutation, type AgentCatalogStore,
  type AgentInspection, type AgentListing, type SkillInspection, type SkillListing } from './contract.js';
import { personaDigest, skillContentDigest, skillSetDigest, skillSignatureMessage } from './digests.js';
import { agentPromptBytes, agentPromptParts } from './selection.js';

type Item = AgentDefinition | SkillDefinition;
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
      return { schemaVersion: 1 as const, status: 'ok' as const, item, history: rows, ...await extra(store, item) };
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
  async defineAgent(input: unknown, credential?: unknown): Promise<AgentCatalogMutation<AgentDefinition>> {
    const command = agentDefineCommandSchema.parse(input), { principal, authorization } = await this.admit('define', command.scopeId, credential);
    return this.mutate('agent', command, command.agentId, principal, authorization.revision, async (store, previous) => {
      const classes = this.deps.workClassIds ? await this.deps.workClassIds(command.scopeId) : null;
      if (classes && command.content.workClasses.some(id => !classes.includes(id))) throw new AgentCatalogError('AGENT_WORK_CLASS_UNKNOWN');
      const skills: SkillDefinition[] = [];
      for (const ref of command.content.skills) {
        const skill = await store.loadSkill(command.scopeId, ref.skillId, ref.revision);
        if (!skill || inScope(skill, command.scopeId).skillId !== ref.skillId || skill.revision !== ref.revision || skill.contentDigest !== ref.digest) throw new AgentCatalogError('AGENT_SKILL_NOT_PINNED');
        skills.push(skill);
      }
      const item = defineAgentRevision(previous as AgentDefinition | null, { scopeId: command.scopeId, agentId: command.agentId, commandId: command.commandId, content: command.content,
        personaDigest: personaDigest(command.content.persona), skillSetDigest: skillSetDigest(command.content.skills), author: principal, atMs: this.deps.now() });
      // S8-1a (§5, N16): persona + pinned skills must leave the reserved task budget of the worker prompt bound, checked here and again at admission.
      const bound = this.deps.promptCompositionMaxBytes;
      if (bound !== undefined && agentPromptBytes(agentPromptParts(item, skills)) > bound - AGENT_CATALOG_LIMITS.promptReservedTaskBytes) throw new AgentCatalogError('AGENT_PROMPT_TOO_LARGE');
      const prior = previous as AgentDefinition | null, kept = new Set(prior?.content.skills.map(ref => JSON.stringify(ref)) ?? []);
      // Q-S6: inheritance needs the same skill set or local-only added/changed skills (an imported one always restarts at candidate).
      const importChanged = skills.some(skill => skill.source.kind === 'import' && !kept.has(JSON.stringify({ skillId: skill.skillId, revision: skill.revision, digest: skill.contentDigest })));
      return { item, standings: initialAgentStandings(item, prior ? { definition: prior, standings: await store.standings(command.scopeId, prior.agentId, prior.revision) } : null, importChanged) };
    }) as Promise<AgentCatalogMutation<AgentDefinition>>;
  }
  /** A person's own skill text (source local, unsigned, pinned by its content digest). Import from elsewhere goes through `importSkill` only. */
  async defineSkill(input: unknown, credential?: unknown): Promise<AgentCatalogMutation<SkillDefinition>> {
    const command = skillDefineCommandSchema.parse(input), { principal, authorization } = await this.admit('define', command.scopeId, credential);
    return this.mutate('skill', command, command.skillId, principal, authorization.revision, async (_store, previous) => ({ item: defineSkillRevision(previous as SkillDefinition | null, {
      scopeId: command.scopeId, skillId: command.skillId, commandId: command.commandId, content: command.content, contentDigest: skillContentDigest(command.content),
      source: { kind: 'local' }, signature: { status: 'unsigned' }, author: principal, atMs: this.deps.now() }) })) as Promise<AgentCatalogMutation<SkillDefinition>>;
  }
  /** Floor (d) for every principal and whatever policy allows: pinned by the digest of the received bytes and signed over (id, digest) by a trusted key. */
  async importSkill(input: unknown, credential?: unknown): Promise<AgentCatalogMutation<SkillDefinition>> {
    const command = skillImportCommandSchema.parse(input), { principal, authorization } = await this.admit('import', command.scopeId, credential);
    const contentDigest = skillContentDigest(command.content);
    requireSkillImportPinnedAndSigned({ declaredDigest: command.pin, computedDigest: contentDigest, signature: command.signature });
    const signature = command.signature!, verify = this.deps.verifySkillSignature;
    requireSkillSignatureVerified(verify ? await verify(signature, skillSignatureMessage({ skillId: command.skillId, contentDigest })) : 'unavailable');
    return this.mutate('skill', command, command.skillId, principal, authorization.revision, async (_store, previous) => ({ item: defineSkillRevision(previous as SkillDefinition | null, {
      scopeId: command.scopeId, skillId: command.skillId, commandId: command.commandId, content: command.content, contentDigest,
      source: { kind: 'import', ref: command.source.ref }, signature: { status: 'verified', ...signature }, author: principal, atMs: this.deps.now() }) })) as Promise<AgentCatalogMutation<SkillDefinition>>;
  }
  /** The current revision's standings, each checked against the row it belongs to (scope, agent, revision, a bound WorkClass). */
  private async standingsOf(store: AgentCatalogStore, item: AgentDefinition): Promise<readonly AgentStanding[]> {
    const rows = await store.standings(item.scopeId, item.agentId, item.revision);
    if (rows.some(row => row.scopeId !== item.scopeId || row.agentId !== item.agentId || row.revision !== item.revision || !item.content.workClasses.includes(row.workClass))) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
    return rows;
  }
  private async mutate(kind: 'agent' | 'skill', command: { scopeId: string; commandId: string; expectedRevision: number | null }, itemId: string,
    principal: VerifiedPrincipal, policyRevision: string, next: (store: AgentCatalogStore, previous: Item | null) => Promise<{ item: Item; standings?: readonly AgentStanding[] }>): Promise<AgentCatalogMutation<Item>> {
    const digest = sha256(encodeCommandProjection(`agent-catalog-${kind}:1`, { command, principal: { issuer: principal.issuer, subject: principal.subject } }));
    const store = await this.deps.openStore('write');
    try {
      const replay = await store.receipt(command.scopeId, command.commandId);
      if (replay) {
        const item = replay.digest === digest && replay.kind === kind && replay.itemId === itemId ? await (kind === 'agent' ? store.loadAgent(command.scopeId, itemId, replay.revision)
          : store.loadSkill(command.scopeId, itemId, replay.revision)) : null;
        if (!item) throw new AgentCatalogStoreError('AGENT_CATALOG_COMMAND_CONFLICT');
        return { schemaVersion: 1, replayed: true, item: inScope(item, command.scopeId) };
      }
      const previous = await (kind === 'agent' ? store.loadAgent(command.scopeId, itemId) : store.loadSkill(command.scopeId, itemId));
      if (command.expectedRevision === null && previous) throw new AgentCatalogStoreError('AGENT_CATALOG_EXISTS');
      if (command.expectedRevision !== null && !previous) throw new AgentCatalogStoreError('AGENT_CATALOG_NOT_FOUND');
      if (previous && inScope(previous, command.scopeId).revision !== command.expectedRevision) throw new AgentCatalogStoreError('AGENT_CATALOG_REVISION_CONFLICT');
      const { item, standings = [] } = await next(store, previous);
      const contentDigest = 'agentId' in item ? item.personaDigest : item.contentDigest;
      const event: AuditEvent = { schemaVersion: 1, eventId: this.deps.eventId(), scopeId: command.scopeId, principal: { issuer: principal.issuer, subject: principal.subject },
        policyRevision, atMs: item.provenance.definedAtMs, subject: { kind: 'agent-catalog', item: kind, action: 'agentId' in item || item.source.kind === 'local' ? 'define' : 'import',
          id: itemId, commandId: command.commandId, revision: item.revision, contentDigest, skillSetDigest: 'agentId' in item ? item.skillSetDigest : null } };
      const receipt = { scopeId: command.scopeId, commandId: command.commandId, kind, itemId, revision: item.revision, digest };
      const saved = await store.commit(kind === 'agent' ? { kind, previous: previous as AgentDefinition | null, next: item as AgentDefinition, receipt, event, standings }
        : { kind, previous: previous as SkillDefinition | null, next: item as SkillDefinition, receipt, event });
      return { schemaVersion: 1, replayed: saved.replayed, item: saved.item };
    } finally { store.close(); }
  }
}
