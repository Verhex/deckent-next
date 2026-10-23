import { catalogAggregatorPrincipal, transitionAgentStanding, encodeCommandProjection, isAiPrincipal, isCatalogAggregatorPrincipal, requireActionSigner, AgentCatalogError, AGENT_CATALOG_LIMITS, type AgentStanding,
  type AuditEvent, type CatalogAction, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { authenticate } from '#engine/core/authentication/index.js';
import { AgentCatalogStoreError, type AgentCatalogAction, type AgentCatalogDependencies, type AgentCatalogStore } from './contract.js';
import { canSignCatalogActions, signCatalogActions } from './signing.js';
import { catalogEvolutionActions, catalogSuggestionAuditSubject, catalogSuggestionStateSchema, catalogSuggestionWorkClass, standingBulkCommandSchema, standingChangeCommandSchema,
  suggestionDismissCommandSchema, suggestionInspectQuerySchema, suggestionListQuerySchema, revokedPromotionsQuerySchema, type CatalogEvolutionChange, type CatalogSuggestion, type CatalogSuggestionInspection,
  type CatalogSuggestionListing, type CatalogSuggestionState, type CatalogSuggestionView, type StoredCatalogSuggestion } from './suggestions.js';

/** The composition root's catalog aggregator for one scope (the installation owner's `<issuer>/catalog-aggregator`, workload-verified). */
export const catalogAggregatorFor = (owner: Ref, scopeId: string) => catalogAggregatorPrincipal(owner, [scopeId]);
const LABELS = Object.freeze({ relation: 'association-not-causation', rate: 'acceptance-rate-not-accuracy' } as const);
type Move = 'promote' | 'demote' | 'restore' | 'retire' | 'narrow';
type Ref = { readonly issuer: string; readonly subject: string };
const ref = (p: Ref) => ({ issuer: p.issuer, subject: p.subject }), same = (a: Ref, b: Ref) => a.issuer === b.issuer && a.subject === b.subject;
const actorOf = (p: VerifiedPrincipal) => ({ ...ref(p), ai: isAiPrincipal(p) });
/** A stand-in signature mark for the dry run that validates a transition before anything is signed (the real mark replaces it). */
const DRY = Object.freeze({ keyId: '0'.repeat(64), signatureDigest: '0'.repeat(64) });
/** Which suggestion kinds a standing card may decide (a promotion decides `promote-agent`; demote, restore and retire decide `redesign-agent`). */
const DECIDES: Readonly<Record<Exclude<Move, 'narrow'>, CatalogSuggestion['kind']>> = { promote: 'promote-agent', demote: 'redesign-agent', restore: 'redesign-agent', retire: 'redesign-agent' };
const mark = (signed: { keyId: string; signature: string } | undefined) => signed && { keyId: signed.keyId, signatureDigest: sha256(signed.signature) };

/**
 * S8-3/S8-4 (S8-DESIGN §6, §7, §8): sole owner of standing and suggestion transitions. A person's terminal card or a signed, WorkClass-granted AI command
 * promotes, demotes, restores, retires or dismisses; only the catalog aggregator writes suggestions and narrows, each signed by its own key; a person's
 * bulk card resets a WorkClass or demotes a revoked key's promotions. Every AI/system signature is verified again in the store's commit transaction.
 * The self-approval guard and the transition table are versioned domain code; nothing here calls a model, reads a model id or deletes a row.
 */
export class AgentStandingApplication {
  constructor(private readonly deps: AgentCatalogDependencies) {}
  private async admit(action: AgentCatalogAction, scopeId: string, principal: VerifiedPrincipal, workClass?: string | null) {
    return this.deps.authorize(action, scopeId, principal, workClass ? `${scopeId}/${workClass}` : undefined);
  }
  private async withStore<T>(access: 'read' | 'write', work: (store: AgentCatalogStore) => Promise<T>): Promise<T> {
    const store = await this.deps.openStore(access);
    try { return await work(store); } finally { store.close(); }
  }
  async listSuggestions(input: unknown, credential?: unknown): Promise<CatalogSuggestionListing> {
    const query = suggestionListQuerySchema.parse(input), principal = await authenticate(this.deps.verifier, credential, query.scopeId);
    await this.admit('inspect', query.scopeId, principal);
    return this.withStore('read', async store => ({ schemaVersion: 1 as const, scopeId: query.scopeId, labels: LABELS,
      items: await this.views(store, principal, query.scopeId, (await store.suggestions(query.scopeId, { ...(query.open ? { open: true } : {}), limit: query.limit })).slice(0, query.limit)) }));
  }
  async inspectSuggestion(input: unknown, credential?: unknown): Promise<CatalogSuggestionInspection> {
    const query = suggestionInspectQuerySchema.parse(input), principal = await authenticate(this.deps.verifier, credential, query.scopeId);
    await this.admit('inspect', query.scopeId, principal);
    return this.withStore('read', async store => {
      const found = await store.suggestion(query.scopeId, query.suggestionId);
      if (!found) return { schemaVersion: 1 as const, status: 'not-found' as const, suggestionId: query.suggestionId };
      const [item] = await this.views(store, principal, query.scopeId, [found]), key = found.record.key;
      const standing = key.kind === 'agent' ? (await store.standings(query.scopeId, key.agentId, key.revision)).find(row => row.workClass === key.workClass) ?? null : null;
      return { schemaVersion: 1 as const, status: 'ok' as const, labels: LABELS, item: item!, standing, history: await store.suggestionHistory(query.scopeId, query.suggestionId) };
    });
  }
  /** The reader's view (N23): lesson refs only where the memory read filter lets this reader read the entry, the rest a count; read-time expiry; an
   * open suggestion whose producer key was revoked since reads `superseded` (not yet an effect, §8) and is marked. */
  private async views(store: AgentCatalogStore, principal: VerifiedPrincipal, scopeId: string, rows: readonly StoredCatalogSuggestion[]): Promise<CatalogSuggestionView[]> {
    const now = this.deps.now(), out: CatalogSuggestionView[] = [];
    for (const { record, state } of rows) {
      if (record.scopeId !== scopeId || state.suggestionId !== record.suggestionId) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
      const p = record.proposed, readable = p.kind !== 'skill-draft' ? [] : this.deps.lessonReadable ? await this.deps.lessonReadable(principal, scopeId, p.lessons) : p.lessons.map(() => false);
      const proposed = p.kind !== 'skill-draft' ? p : { ...p, lessons: p.lessons.filter((_, index) => readable[index] === true), withheld: p.lessons.filter((_, index) => readable[index] !== true).length };
      const revoked = state.state === 'open' && state.signed !== undefined && (await store.signer(scopeId, state.signed.keyId))?.state !== 'active';
      out.push({ ...record, proposed, state: revoked ? 'superseded' : state.state === 'open' && now >= record.expiresAtMs ? 'expired' : state.state, stateRevision: state.revision,
        decidedBy: state.state === 'open' ? null : state.by, decision: state.decision, signerRevoked: revoked });
    }
    return out;
  }
  /**
   * S8-4 (owner Q-S13): the current promotions (`active` standings of current revisions) whose basis a revoked key signed — they stay until a person
   * demotes them; the revoke card lists them with a one-step demote and the monitor counts them ("imzalayan iptal edildi"). `keyId`: only that key's.
   */
  async revokedPromotions(query: unknown, credential?: unknown): Promise<readonly Readonly<{ keyId: string; standing: AgentStanding }>[]> {
    const input = revokedPromotionsQuerySchema.parse(query), principal = await authenticate(this.deps.verifier, credential, input.scopeId);
    await this.admit('inspect', input.scopeId, principal);
    return this.withStore('read', async store => {
      const out: { keyId: string; standing: AgentStanding }[] = [];
      for (const key of (await store.signers(input.scopeId, AGENT_CATALOG_LIMITS.signersPerScopeMax)).filter(row => row.state === 'revoked' && (input.keyId === undefined || row.keyId === input.keyId)))
        for (const standing of await store.signedStandings(input.scopeId, key.keyId, AGENT_CATALOG_LIMITS.agentsPerScopeMax))
          if (standing.standing === 'active' && (await store.loadAgent(input.scopeId, standing.agentId))?.revision === standing.revision) out.push({ keyId: key.keyId, standing });
      return out;
    });
  }
  /** Whether the aggregator (this application's principal) can sign now; without a key the pass writes nothing (the monitor says so). */
  async ready(scopeId: string, credential?: unknown): Promise<boolean> {
    const principal = await authenticate(this.deps.verifier, credential, scopeId);
    return this.withStore('read', store => canSignCatalogActions(this.deps, store, principal, scopeId));
  }
  /** An open, live, unexpired suggestion this card may decide (its producer never decides it; a revoked producer key made it stale). */
  private async decidable(store: AgentCatalogStore, scopeId: string, suggestionId: string, principal: VerifiedPrincipal): Promise<StoredCatalogSuggestion> {
    const found = await store.suggestion(scopeId, suggestionId);
    if (!found) throw new AgentCatalogStoreError('AGENT_CATALOG_NOT_FOUND');
    const { record, state } = found;
    if (record.scopeId !== scopeId) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
    if (record.mode !== 'on') throw new AgentCatalogError('CATALOG_SUGGESTION_SHADOW');
    if (same(record.producer, principal)) throw new AgentCatalogError('AGENT_STANDING_REFUSED');
    const revoked = state.signed !== undefined && (await store.signer(scopeId, state.signed.keyId))?.state !== 'active';
    if (state.state !== 'open' || this.deps.now() >= record.expiresAtMs || revoked) throw new AgentCatalogError('CATALOG_SUGGESTION_STALE');
    return found;
  }
  private decided(found: StoredCatalogSuggestion, principal: VerifiedPrincipal, at: number, commandId: string, decision: string, signed?: { keyId: string; signatureDigest: string }): CatalogSuggestionState {
    return catalogSuggestionStateSchema.parse({ schemaVersion: 1, scopeId: found.record.scopeId, suggestionId: found.record.suggestionId, state: decision === 'dismiss' ? 'dismissed' : 'decided',
      revision: found.state.revision + 1, by: actorOf(principal), atMs: at, commandId, decision, supersededBy: null, ...(signed ? { signed } : {}) });
  }
  private event(scopeId: string, principal: Ref, policyRevision: string, atMs: number, subject: AuditEvent['subject']): AuditEvent {
    return { schemaVersion: 1, eventId: this.deps.eventId(), scopeId, principal: ref(principal), policyRevision, atMs, subject };
  }
  private standingEvent(scopeId: string, principal: Ref, policyRevision: string, row: CatalogEvolutionChange['standings'][number]): AuditEvent {
    const next = row.next;
    return this.event(scopeId, principal, policyRevision, next.basis.atMs, { kind: 'agent-standing', action: row.action, agentId: next.agentId, revision: next.revision, workClass: next.workClass,
      from: row.previous.standing, to: next.standing, standingRevision: next.standingRevision, suggestionId: next.basis.suggestionId, commandId: next.basis.commandId ?? `catalog-narrow:${next.basis.suggestionId}`,
      ...(next.basis.signed ? { signed: next.basis.signed } : {}) });
  }
  /** Receipt replay of a card command: the same digest answers replayed (a signed AI command only while its key is still active, N38), another is a conflict. */
  private async replay(store: AgentCatalogStore, scopeId: string, commandId: string, digest: string, principal: VerifiedPrincipal) {
    const receipt = await store.standingReceipt(scopeId, commandId);
    if (!receipt) return false;
    if (receipt.digest !== digest) throw new AgentCatalogStoreError('AGENT_CATALOG_COMMAND_CONFLICT');
    if (receipt.keyId) requireActionSigner(await store.signer(scopeId, receipt.keyId), scopeId, principal);
    return true;
  }
  private digest(kind: string, command: object, principal: Ref) {
    return sha256(encodeCommandProjection(`agent-standing-${kind}:1`, { command: { ...command, signed: undefined }, principal: ref(principal) }));
  }

  /** A standing card: promote (the WorkClass's current `active` agent becomes `candidate` in the same change), demote, restore or retire one revision. */
  async change(input: unknown, credential?: unknown): Promise<{ readonly schemaVersion: 1; readonly replayed: boolean; readonly standings: readonly AgentStanding[] }> {
    const command = standingChangeCommandSchema.parse(input), principal = await authenticate(this.deps.verifier, credential, command.scopeId), scopeId = command.scopeId;
    const authorization = await this.admit(command.action, scopeId, principal, command.workClass), digest = this.digest('change', command, principal);
    return this.withStore('write', async store => {
      const current = (await store.standings(scopeId, command.agentId, command.revision)).find(row => row.workClass === command.workClass);
      if (await this.replay(store, scopeId, command.commandId, digest, principal)) return { schemaVersion: 1 as const, replayed: true, standings: current ? [current] : [] };
      const agent = await store.loadAgent(scopeId, command.agentId, command.revision), head = await store.loadAgent(scopeId, command.agentId);
      if (!current || !agent || !head) throw new AgentCatalogStoreError('AGENT_CATALOG_NOT_FOUND');
      if ((command.action === 'promote' || command.action === 'restore') && head.revision !== command.revision) throw new AgentCatalogError('AGENT_STANDING_REFUSED');
      // A restore of a narrowed revision decides the narrowing's suggestion when it is still open (restore starts the cooldown, N35).
      const auto = command.suggestionId === null && command.action === 'restore' && current.basis.kind === 'rule' ? current.basis.suggestionId : null;
      const found = command.suggestionId ? await this.decidable(store, scopeId, command.suggestionId, principal)
        : auto ? await this.decidable(store, scopeId, auto, principal).catch(() => null) : null;
      const key = found?.record.key;
      if (found && (found.record.kind !== DECIDES[command.action] || key?.kind !== 'agent' || key.agentId !== command.agentId || key.revision !== command.revision || key.workClass !== command.workClass))
        throw new AgentCatalogError('CATALOG_SUGGESTION_STALE');
      const displaced = command.action === 'promote' ? (await store.eligibleAgents(scopeId, command.workClass, AGENT_CATALOG_LIMITS.agentsPerScopeMax))
        .find(row => row.standing.standing === 'active' && row.agent.agentId !== command.agentId)?.standing ?? null : null;
      const at = this.deps.now(), actor = actorOf(principal), suggestionId = found?.record.suggestionId ?? null;
      const move = (signed?: { keyId: string; signatureDigest: string }) => transitionAgentStanding(current, { action: command.action, expectedStandingRevision: command.expectedStandingRevision, actor,
        atMs: at, commandId: command.commandId, suggestionId, displaced, author: agent.provenance.author, producer: found?.record.producer ?? null, ...(signed ? { signed } : {}) });
      const dry = move(actor.ai ? DRY : undefined), receipt = { scopeId, commandId: command.commandId, digest };
      const changes = (rows: readonly AgentStanding[]) => rows.map((next, index) => ({ previous: index === 0 ? current : displaced!, next, action: index === 0 ? command.action : 'demote' as const }));
      const plan = { scopeId, principal: actor, receipt, standings: changes(dry), suggestions: [], states: [] };
      const signed = await signCatalogActions(this.deps, store, principal, scopeId, catalogEvolutionActions(plan, new Map()), command.signed), sig = mark(signed[0]);
      const standings = changes(move(sig)), states = found ? [{ previous: found.state, next: this.decided(found, principal, at, command.commandId, command.action, sig) }] : [];
      const events = [...standings.map(row => this.standingEvent(scopeId, principal, authorization.revision, row)),
        ...states.map(row => this.event(scopeId, principal, authorization.revision, at, catalogSuggestionAuditSubject(found!.record, 'decide', row.next)))];
      const saved = await store.commitEvolution({ ...plan, standings, states, signed, events });
      return { schemaVersion: 1 as const, replayed: saved.replayed, standings: standings.map(row => row.next) };
    });
  }
  /** Dismiss one open suggestion (changes no standing; the same key re-opens only after the cooldown in a non-overlapping window). */
  async dismiss(input: unknown, credential?: unknown): Promise<{ readonly schemaVersion: 1; readonly replayed: boolean; readonly state: CatalogSuggestionState }> {
    const command = suggestionDismissCommandSchema.parse(input), principal = await authenticate(this.deps.verifier, credential, command.scopeId), scopeId = command.scopeId;
    const record = await this.withStore('read', store => store.suggestion(scopeId, command.suggestionId));
    if (!record) throw new AgentCatalogStoreError('AGENT_CATALOG_NOT_FOUND');
    const authorization = await this.admit('dismiss', scopeId, principal, catalogSuggestionWorkClass(record.record.key)), digest = this.digest('dismiss', command, principal);
    return this.withStore('write', async store => {
      if (await this.replay(store, scopeId, command.commandId, digest, principal)) return { schemaVersion: 1 as const, replayed: true, state: (await store.suggestion(scopeId, command.suggestionId))!.state };
      const found = await this.decidable(store, scopeId, command.suggestionId, principal), at = this.deps.now();
      if (found.state.revision !== command.expectedStateRevision) throw new AgentCatalogError('CATALOG_SUGGESTION_STALE');
      const receipt = { scopeId, commandId: command.commandId, digest }, records = new Map([[found.record.suggestionId, found.record]]);
      const plan = { scopeId, principal: actorOf(principal), receipt, standings: [], suggestions: [], states: [{ previous: found.state, next: this.decided(found, principal, at, command.commandId, 'dismiss') }] };
      const signed = await signCatalogActions(this.deps, store, principal, scopeId, catalogEvolutionActions(plan, records), command.signed);
      const next = this.decided(found, principal, at, command.commandId, 'dismiss', mark(signed[0]));
      await store.commitEvolution({ ...plan, states: [{ previous: found.state, next }], signed,
        events: [this.event(scopeId, principal, authorization.revision, at, catalogSuggestionAuditSubject(found.record, 'dismiss', next))] });
      return { schemaVersion: 1 as const, replayed: false, state: next };
    });
  }
  /**
   * A person's bulk card (never an AI's): `reset` moves every promoted or narrowed current revision of one WorkClass back to candidate; `signer-revoked`
   * demotes every promotion a revoked key signed (owner Q-S13: they stay until a person demotes them — this is that one step). The targets must be
   * exactly the rows the card showed, each at the shown standing revision (a change in between is a conflict, nothing is written).
   */
  async bulk(input: unknown, credential?: unknown): Promise<{ readonly schemaVersion: 1; readonly replayed: boolean; readonly standings: readonly AgentStanding[] }> {
    const command = standingBulkCommandSchema.parse(input), principal = await authenticate(this.deps.verifier, credential, command.scopeId), scopeId = command.scopeId;
    if (isAiPrincipal(principal)) throw new AgentCatalogError('AGENT_STANDING_REFUSED');
    const classes = [...new Set(command.targets.map(row => row.workClass))], revisions: string[] = [];
    for (const workClass of classes) for (const action of ['demote', 'restore'] as const) revisions.push((await this.admit(action, scopeId, principal, workClass)).revision);
    const digest = this.digest('bulk', command, principal);
    return this.withStore('write', async store => {
      if (await this.replay(store, scopeId, command.commandId, digest, principal)) return { schemaVersion: 1 as const, replayed: true, standings: [] };
      const reason = command.reason, rows: AgentStanding[] = [];
      if (reason.kind === 'reset') {
        for (const agent of await store.listAgents(scopeId, AGENT_CATALOG_LIMITS.agentsPerScopeMax)) {
          const row = (await store.standings(scopeId, agent.agentId, agent.revision)).find(value => value.workClass === reason.workClass);
          if (row && (row.standing === 'active' || row.standing === 'redesign-required')) rows.push(row);
        }
      } else {
        if ((await store.signer(scopeId, reason.keyId))?.state !== 'revoked') throw new AgentCatalogError('AGENT_STANDING_REFUSED');
        rows.push(...(await store.signedStandings(scopeId, reason.keyId, AGENT_CATALOG_LIMITS.agentsPerScopeMax)).filter(row => row.standing === 'active'));
      }
      const wanted = new Set(command.targets.map(row => JSON.stringify([row.agentId, row.revision, row.workClass, row.expectedStandingRevision])));
      if (rows.length !== wanted.size || rows.some(row => !wanted.has(JSON.stringify([row.agentId, row.revision, row.workClass, row.standingRevision])))) throw new AgentCatalogError('AGENT_STANDING_CONFLICT');
      const at = this.deps.now(), actor = actorOf(principal);
      const standings = rows.map(previous => {
        const action = previous.standing === 'active' ? 'demote' as const : 'restore' as const;
        return { previous, action, next: transitionAgentStanding(previous, { action, expectedStandingRevision: previous.standingRevision, actor, atMs: at, commandId: command.commandId, suggestionId: null,
          reasonCode: reason.kind })[0]! };
      });
      await store.commitEvolution({ scopeId, principal: actor, receipt: { scopeId, commandId: command.commandId, digest }, standings, suggestions: [], states: [], signed: [],
        events: standings.map(row => this.standingEvent(scopeId, principal, revisions[0]!, row)) });
      return { schemaVersion: 1 as const, replayed: false, standings: standings.map(row => row.next) };
    });
  }

  /**
   * The aggregator's write (S8-3): new suggestions (each superseding the open one of its key and kind) and, for a sealed `redesign-agent` suggestion of a
   * calibrated rule in mode `on` (the caller decides that), the automatic narrowing — suggestion, standing revision and audit in one transaction, all
   * signed by the aggregator's own key (no key: refused, nothing written). A suggestion already held is skipped (replay, N10). It never widens.
   */
  async record(scopeId: string, input: { readonly suggestions: readonly CatalogSuggestion[]; readonly narrow: readonly string[] }, credential?: unknown)
    : Promise<{ readonly written: number; readonly superseded: number; readonly narrowed: number }> {
    const principal = await authenticate(this.deps.verifier, credential, scopeId);
    if (!isCatalogAggregatorPrincipal(principal)) throw new AgentCatalogError('AGENT_STANDING_REFUSED');
    const authorization = await this.admit('suggest', scopeId, principal);
    if (input.narrow.length) await this.admit('narrow', scopeId, principal);
    return this.withStore('write', async store => {
      const fresh: CatalogSuggestion[] = [], states: { previous: CatalogSuggestionState | null; next: CatalogSuggestionState }[] = [], records = new Map<string, CatalogSuggestion>(), priors = new Map(records);
      for (const record of input.suggestions) {
        if (record.scopeId !== scopeId || !same(record.producer, principal) || fresh.some(row => row.keyDigest === record.keyDigest && row.kind === record.kind)) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
        if (await store.suggestion(scopeId, record.suggestionId)) continue;
        fresh.push(record); records.set(record.suggestionId, record);
        for (const prior of await store.suggestions(scopeId, { keyDigest: record.keyDigest, open: true, limit: AGENT_CATALOG_LIMITS.pageMax })) {
          if (prior.record.kind !== record.kind) continue;
          priors.set(prior.record.suggestionId, prior.record);
          states.push({ previous: prior.state, next: catalogSuggestionStateSchema.parse({ ...prior.state, state: 'superseded', revision: prior.state.revision + 1, by: actorOf(principal),
            atMs: record.asOfMs, commandId: null, decision: null, supersededBy: record.suggestionId, signed: undefined }) });
        }
      }
      const narrowed: { previous: AgentStanding; record: CatalogSuggestion }[] = [];
      for (const suggestionId of input.narrow) {
        const record = records.get(suggestionId), key = record?.key;
        if (!record || record.kind !== 'redesign-agent' || key?.kind !== 'agent') continue;
        const previous = (await store.standings(scopeId, key.agentId, key.revision)).find(row => row.workClass === key.workClass);
        if (previous && (previous.standing === 'active' || previous.standing === 'candidate')) narrowed.push({ previous, record });
      }
      if (!fresh.length) return { written: 0, superseded: 0, narrowed: 0 };
      const actor = actorOf(principal), narrow = (sig: (id: string) => { keyId: string; signatureDigest: string }) => narrowed.map(({ previous, record }) => ({ previous, action: 'narrow' as const,
        next: transitionAgentStanding(previous, { action: 'narrow', expectedStandingRevision: previous.standingRevision, actor, atMs: record.asOfMs, commandId: null, suggestionId: record.suggestionId,
          reasonCode: record.rule.id, signed: sig(record.suggestionId) })[0]! }));
      const plan = { scopeId, principal: actor, receipt: null, standings: narrow(() => DRY), suggestions: fresh, states: [] };
      const actions: CatalogAction[] = catalogEvolutionActions(plan, records), signed = await signCatalogActions(this.deps, store, principal, scopeId, actions);
      const markOf = (action: 'suggest' | 'narrow', id: string) => mark(signed.find(row => row.action.action === action && row.action.suggestionId === id))!;
      const opening = fresh.map(record => ({ previous: null, next: catalogSuggestionStateSchema.parse({ schemaVersion: 1, scopeId, suggestionId: record.suggestionId, state: 'open', revision: 1, by: actor,
        atMs: record.asOfMs, commandId: `catalog-suggest:${record.suggestionId}`, decision: null, supersededBy: null, signed: markOf('suggest', record.suggestionId) }) }));
      const standings = narrow(id => markOf('narrow', id)), all = [...opening, ...states];
      const events = [...all.map(row => this.event(scopeId, principal, authorization.revision, row.next.atMs,
        catalogSuggestionAuditSubject((row.previous ? priors : records).get(row.next.suggestionId)!, row.previous ? 'supersede' : 'suggest', row.next))),
        ...standings.map(row => this.standingEvent(scopeId, principal, authorization.revision, row))];
      await store.commitEvolution({ ...plan, standings, states: all, signed, events });
      return { written: fresh.length, superseded: states.length, narrowed: standings.length };
    });
  }
}
