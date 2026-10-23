import { encodeCommandProjection, proposeMemoryEntry, verifyMemoryEntry, retireMemoryEntry, memorySearchTerms, memoryEntryMatches, isMemoryDistillerPrincipal, composeMemoryAutomation,
  MEMORY_LIMITS, memoryExtractionSourceSchema, type AuditEvent, type MemoryEntry, type MemoryExtractionSource, type MemoryState, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { authenticate } from '#engine/core/authentication/index.js';
import { memoryProposeCommandSchema, memoryVerifyCommandSchema, memoryRetireCommandSchema, memoryInspectQuerySchema, memoryListQuerySchema, memorySearchQuerySchema,
  memoryExtractCommandSchema, memoryReviewQuerySchema, memorySourceQuerySchema, memoryRolloutQuerySchema, MemoryJournalError, type MemoryAction, type MemoryHeld, type MemoryInspection, type MemoryJournalDependencies, type MemoryJournalStore, type MemoryListing,
  type MemoryMutationResult, type MemorySearchResult, type MemorySupport, type MemoryDistilOutcome, type MemoryReview, type MemorySourceEntries, type MemoryPurgeResult,
  type MemoryPurgeReplay, type MemoryContestResolveResult } from './contract.js';
import { distilSource } from './distil.js';
import type { MemoryReportClaims } from './source.js';
import { assertNoPendingMemoryPurge, memorySourceEntries, purgeMemoryEntry, replayMemoryPurges, resolveMemoryContest, reviewMemory } from './purge.js';
import { rederiveMemorySourceModels } from './evaluate.js';
import { selectMemoryContext, selectMemoryPlanningContext, type MemoryContextRequest, type MemoryContextSelection, type MemoryPlanningRequest, type MemoryPlanningSelection } from './context.js';
import { PolicyAuthorizationError } from '#engine/core/policy/index.js';
import { measureMemoryRollout, type MemoryRolloutPorts, type MemoryRolloutStatus } from './rollout.js';

const DEFAULT_STATES: readonly MemoryState[] = Object.freeze(['candidate', 'verified']);
const held = (error: unknown): MemoryHeld => ({ schemaVersion: 1, status: 'held',
  code: error instanceof MemoryJournalError && (error.code === 'MEMORY_CORRUPT' || error.code === 'MEMORY_PURGE_REPLAY_HELD') ? error.code : 'MEMORY_UNAVAILABLE' });
const inScope = (entry: MemoryEntry, scopeId: string) => { if (entry.scopeId !== scopeId) throw new MemoryJournalError('MEMORY_CORRUPT'); return entry; };

/** Sole owner of memory journal transitions (one writer per scope through the store's compare-and-set). Reads hold on failure; nothing deletes. */
export class MemoryJournalApplication {
  constructor(private readonly deps: MemoryJournalDependencies) {}
  private async admit(action: MemoryAction, scopeId: string, credential?: unknown) {
    const principal = await authenticate(this.deps.verifier, credential, scopeId);
    return { principal, authorization: await this.deps.authorize(action, scopeId, principal) };
  }
  /** Authorization refusals throw; every failure after it (open, integrity, dangling index) becomes a typed hold. A withheld entry is a refusal. */
  private async read<T>(scopeId: string, credential: unknown, work: (store: MemoryJournalStore, principal: VerifiedPrincipal) => Promise<T>): Promise<T | MemoryHeld> {
    const { principal } = await this.admit('inspect', scopeId, credential);
    let store: MemoryJournalStore;
    try { store = await this.deps.openStore('read'); } catch (error) { return held(error); }
    // S4B-4 §6.6: a purge the journal holds and the ledger lacks (a restored backup) holds every read until it is re-applied.
    try { await assertNoPendingMemoryPurge(this.deps, store, scopeId); return await work(store, principal); }
    catch (error) { if (error instanceof MemoryJournalError && error.code === 'MEMORY_ENTRY_WITHHELD') throw error; return held(error); } finally { store.close(); }
  }
  /**
   * S4B-1 §7.4 source filter (one owner for CLI and MCP): a system-derived entry (with an audience) is visible only when the caller may read the
   * output of at least one of its first `maxSourcesChecked` source Attempts and may use its work target. A person's entry needs `inspect` only.
   * Pure policy evaluation over one loaded document; no filter wired or no support port: every system entry is withheld (fail closed).
   */
  private async visible(store: MemoryJournalStore, principal: VerifiedPrincipal, scopeId: string, entries: readonly MemoryEntry[]) {
    const system = entries.filter(entry => entry.audience);
    const filter = system.length && this.deps.readFilter ? await this.deps.readFilter(principal, scopeId) : null, checked = composeMemoryAutomation(this.deps.automation).context.maxSourcesChecked;
    const shown: MemoryEntry[] = [];
    for (const entry of entries) {
      const audience = entry.audience;
      if (!audience) { shown.push(entry); continue; }
      if (!filter || !store.listSupport || (audience.workTargetId !== null && !filter({ kind: 'work-target', id: audience.workTargetId }, 'use'))) continue;
      if ((await store.listSupport(scopeId, entry.entryId, checked)).some(row => filter({ kind: 'attempt', id: row.source.attemptId }, 'read-output'))) shown.push(entry);
    }
    return { entries: shown, withheld: entries.length - shown.length };
  }
  async inspect(input: unknown, credential?: unknown): Promise<MemoryInspection> {
    const query = memoryInspectQuerySchema.parse(input);
    return this.read(query.scopeId, credential, async (store, principal) => {
      const entry = await store.load(query.scopeId, query.entryId);
      if (!entry) return { schemaVersion: 1 as const, status: 'not-found' as const, entryId: query.entryId };
      const history = (await store.history(query.scopeId, query.entryId, MEMORY_LIMITS.historyMax)).map(item => inScope(item, query.scopeId));
      if (inScope(entry, query.scopeId).entryId !== query.entryId || history.at(-1)?.revision !== entry.revision) throw new MemoryJournalError('MEMORY_CORRUPT');
      if ((await this.visible(store, principal, query.scopeId, [entry])).withheld) throw new MemoryJournalError('MEMORY_ENTRY_WITHHELD');
      return { schemaVersion: 1 as const, status: 'ok' as const, entry, history };
    });
  }
  async list(input: unknown, credential?: unknown): Promise<MemoryListing> {
    const query = memoryListQuerySchema.parse(input), states = query.states ?? DEFAULT_STATES;
    return this.read(query.scopeId, credential, async (store, principal) => {
      const entries = (await store.list(query.scopeId, states, query.limit)).slice(0, query.limit).map(entry => inScope(entry, query.scopeId));
      return { schemaVersion: 1 as const, status: 'ok' as const, scopeId: query.scopeId, ...await this.visible(store, principal, query.scopeId, entries) };
    });
  }
  async search(input: unknown, credential?: unknown): Promise<MemorySearchResult> {
    const query = memorySearchQuerySchema.parse(input), states = query.states ?? DEFAULT_STATES, terms = memorySearchTerms(query.query);
    return this.read(query.scopeId, credential, async (store, principal) => {
      const ok = { schemaVersion: 1 as const, status: 'ok' as const, scopeId: query.scopeId, terms };
      if (store.capabilities.fullTextSearch && store.search) {
        const entries: MemoryEntry[] = [];
        for (const id of (await store.search(query.scopeId, terms, states, query.limit)).slice(0, query.limit)) {
          const entry = await store.load(query.scopeId, id);
          // An index naming an entry the journal does not hold is an integrity failure, never a silently shorter answer.
          if (!entry || !states.includes(inScope(entry, query.scopeId).state)) throw new MemoryJournalError('MEMORY_CORRUPT');
          entries.push(entry);
        }
        return { ...ok, method: 'full-text' as const, complete: true, ...await this.visible(store, principal, query.scopeId, entries) };
      }
      const scanned = (await store.list(query.scopeId, states, MEMORY_LIMITS.scanMax + 1)).map(entry => inScope(entry, query.scopeId));
      return { ...ok, method: 'scan' as const, complete: scanned.length <= MEMORY_LIMITS.scanMax,
        ...await this.visible(store, principal, query.scopeId, scanned.slice(0, MEMORY_LIMITS.scanMax).filter(entry => memoryEntryMatches(entry, terms)).slice(0, query.limit)) };
    });
  }
  /**
   * S4B-5 (§7.1, §7.3): the worker memory of one Run admission, read as the admitting principal. A refusal of its `memory/inspect` is a withheld
   * part (the Run goes on without memory, visibly); an unreadable policy, store, key or index, or a purge the ledger lacks, is a typed hold.
   */
  contextFor(request: MemoryContextRequest, credential?: unknown): Promise<MemoryContextSelection> {
    return this.contextRead(request.scopeId, credential, (store, principal, revision) => selectMemoryContext(this.deps, store, principal, revision, request, (...args) => this.visible(...args)));
  }
  /** S4B-6 (§7.2, §7.3): the planning memory of one Brain request, read as the requesting person under the same rules as `contextFor`. */
  planningContextFor(request: MemoryPlanningRequest, credential?: unknown): Promise<MemoryPlanningSelection> {
    return this.contextRead(request.scopeId, credential, (store, principal, revision) => selectMemoryPlanningContext(this.deps, store, principal, revision, request, (...args) => this.visible(...args)));
  }
  private async contextRead<T>(scopeId: string, credential: unknown, select: (store: MemoryJournalStore, principal: VerifiedPrincipal, policyRevision: string) => Promise<T>)
    : Promise<T | MemoryHeld | { readonly schemaVersion: 1; readonly status: 'withheld'; readonly reason: 'policy' }> {
    let admitted;
    try { admitted = await this.admit('inspect', scopeId, credential); }
    catch (error) { if (error instanceof PolicyAuthorizationError && error.code !== 'POLICY_UNAVAILABLE') return { schemaVersion: 1, status: 'withheld', reason: 'policy' }; throw error; }
    let store: MemoryJournalStore;
    try { store = await this.deps.openStore('read'); } catch (error) { return held(error); }
    try {
      await assertNoPendingMemoryPurge(this.deps, store, scopeId);
      return await select(store, admitted.principal, admitted.authorization.revision);
    } catch (error) { return held(error); } finally { store.close(); }
  }
  async propose(input: unknown, credential?: unknown): Promise<MemoryMutationResult> {
    const command = memoryProposeCommandSchema.parse(input), { principal, authorization } = await this.admit('propose', command.scopeId, credential);
    const contentDigest = this.deps.keyedDigest('memory-content:2', command.content);
    return this.mutate('propose', command, principal, authorization.revision, command.commandId, null, async (_previous, store) => {
      if (await store.findTombstone?.(command.scopeId, contentDigest)) throw new MemoryJournalError('MEMORY_PURGED_CONTENT');
      return proposeMemoryEntry({ scopeId: command.scopeId, entryId: command.commandId, commandId: command.commandId, content: command.content, origin: command.origin,
        author: principal, atMs: this.deps.now(), contentDigest });
    });
  }
  /**
   * S4B-1 §4.3: the distiller's candidate. The entry id is the keyed digest of (scope, audience, content), so the same knowledge from another
   * Attempt adds a support row to the one entry (whatever its state: retired stays retired) instead of a second entry; a replay adds nothing;
   * purged content is refused. Support rows per entry are bounded by the registry.
   */
  async proposeExtracted(input: unknown, credential?: unknown): Promise<{ readonly status: 'proposed' | 'supported' | 'replayed'; readonly entry: MemoryEntry }> {
    const command = memoryExtractCommandSchema.parse(input), { principal, authorization } = await this.admit('propose', command.scopeId, credential);
    if (!isMemoryDistillerPrincipal(principal)) throw new MemoryJournalError('MEMORY_DISTILLER_REQUIRED');
    const { scopeId, source, content, audience } = command, kd = this.deps.keyedDigest;
    const commandId = sha256(encodeCommandProjection('memory-extract:1', { scopeId, source, ruleId: command.ruleId, ruleVersion: command.ruleVersion, claimIndex: command.claimIndex }));
    const entryId = kd('memory-entry:2', { scopeId, audience, content }), contentDigest = kd('memory-content:2', content), bound = composeMemoryAutomation(this.deps.automation).bounds.supportPerEntry;
    const support: MemorySupport = { schemaVersion: 1, scopeId, entryId, supportId: commandId, producer: command.support.producer, source, ruleId: command.ruleId,
      ruleVersion: command.ruleVersion, evaluationId: command.support.evaluationId, evaluationDigest: command.support.evaluationDigest, reportDigest: command.support.reportDigest, atMs: this.deps.now() };
    const store = await this.deps.openStore('write');
    try {
      if (!store.appendSupport || !store.listSupport || !store.findTombstone) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
      await assertNoPendingMemoryPurge(this.deps, store, scopeId);
      const existing = await store.load(scopeId, entryId);
      if (existing) {
        const rows = await store.listSupport(scopeId, entryId, bound);
        if (rows.some(row => row.supportId === commandId)) return { status: 'replayed', entry: inScope(existing, scopeId) };
        if (rows.length >= bound) throw new MemoryJournalError('MEMORY_EXTRACTION_BOUND');
        return { status: (await store.appendSupport(support)).replayed ? 'replayed' : 'supported', entry: inScope(existing, scopeId) };
      }
      if (await store.findTombstone(scopeId, contentDigest)) throw new MemoryJournalError('MEMORY_PURGED_CONTENT');
    } finally { store.close(); }
    const saved = await this.mutate('propose', { scopeId, commandId }, principal, authorization.revision, entryId, null, () => proposeMemoryEntry({ scopeId, entryId, commandId, content,
      contentDigest, author: principal, atMs: support.atMs, audience, origin: { kind: 'run', ref: `run/${source.runId}/task/${source.taskId}/attempt/${source.attemptId}` } }), support, command);
    return { status: saved.replayed ? 'replayed' : 'proposed', entry: saved.entry };
  }
  /**
   * S4B-1 §4.1: one bounded page of the scope's accepted Tasks after the durable cursor (`loopPage` from the registry), each distilled once, the
   * cursor advanced past each. Off the hot path (the service's reconciliation pass calls it); an error stops the page with the cursor at the
   * last finished source, so the next pass retries it.
   */
  async distilPage(scopeId: string, mode: 'live' | 'shadow', port: { page(after: string | null, limit: number): Promise<readonly { readonly position: string; readonly source: unknown }[]>;
    /** S4B-2 (E3): the lesson claims of an accepted source's sealed report, read under the distiller's own `attempt/read-output` decision; the port returns
     * null when the decision refuses or no claim is sealed (the source then yields no E3 candidate, never an error). */
    report?(source: MemoryExtractionSource, principal: VerifiedPrincipal): Promise<MemoryReportClaims | null> },
    credential?: unknown): Promise<{ readonly processed: number; readonly outcomes: readonly MemoryDistilOutcome[] }> {
    const { principal } = await this.admit('propose', scopeId, credential);
    if (!isMemoryDistillerPrincipal(principal)) throw new MemoryJournalError('MEMORY_DISTILLER_REQUIRED');
    const limit = composeMemoryAutomation(this.deps.automation).bounds.loopPage, store = await this.deps.openStore('write');
    let after: string | null;
    try { if (!store.extractionCursor || !store.advanceCursor) throw new MemoryJournalError('MEMORY_UNAVAILABLE'); after = await store.extractionCursor(scopeId); } finally { store.close(); }
    const outcomes: MemoryDistilOutcome[] = [];
    for (const row of (await port.page(after, limit)).slice(0, limit)) {
      // A row without a sealed source (Run or evaluation gone) is passed over; it is never invented.
      if (row.source !== null) outcomes.push(await this.distil(await this.withReport(row.source, port, principal), { mode }, credential));
      const store = await this.deps.openStore('write');
      try { await store.advanceCursor!(scopeId, row.position); } finally { store.close(); }
    }
    return { processed: outcomes.length, outcomes };
  }
  /** E3's input only for an accepted, settled source whose Attempt left claims; every other source goes on unchanged (the schema parse stays distil's). */
  private async withReport(input: unknown, port: { report?(source: MemoryExtractionSource, principal: VerifiedPrincipal): Promise<MemoryReportClaims | null> }, principal: VerifiedPrincipal): Promise<unknown> {
    const parsed = port.report ? memoryExtractionSourceSchema.safeParse(input) : null;
    if (!parsed?.success || !parsed.data.accepted || !parsed.data.settled) return input;
    const claims = await port.report!(parsed.data, principal);
    return claims ? { ...parsed.data, lessons: claims.lessons, reportDigest: claims.reportDigest } : input;
  }
  /** S4B-1 §4.1–§4.5: the distiller's pass over one sealed source (rules, WorkClass gate, screening, bounds, once per Attempt). Off the hot path. */
  async distil(input: unknown, options: { readonly mode: 'live' | 'shadow' }, credential?: unknown): Promise<MemoryDistilOutcome> {
    return distilSource(this.deps, input, options, {
      admit: async scopeId => { const { principal } = await this.admit('propose', scopeId, credential);
        if (!isMemoryDistillerPrincipal(principal)) throw new MemoryJournalError('MEMORY_DISTILLER_REQUIRED'); },
      propose: command => this.proposeExtracted(command, credential) });
  }
  async verify(input: unknown, credential?: unknown): Promise<MemoryMutationResult> {
    const command = memoryVerifyCommandSchema.parse(input), { principal, authorization } = await this.admit('verify', command.scopeId, credential);
    return this.mutate('verify', command, principal, authorization.revision, command.entryId, command.expectedRevision, async (previous, store) => {
      const evaluation = command.basis.kind === 'independent-evaluation' ? await this.deps.resolveEvaluation?.(command.scopeId, command.basis.record) ?? null : null;
      // S4B-3 §6.3: independence binds to the sealed Runs, re-derived here at the transition (never taken from the record or the support rows).
      const sources = evaluation ? await rederiveMemorySourceModels(store, this.deps.evaluationSources, composeMemoryAutomation(this.deps.automation), previous!) : null;
      return verifyMemoryEntry(previous!, { actor: principal, atMs: this.deps.now(), basis: command.basis, evaluation, sourceModels: sources?.models ?? null });
    });
  }
  async retire(input: unknown, credential?: unknown): Promise<MemoryMutationResult> {
    const command = memoryRetireCommandSchema.parse(input), { principal, authorization } = await this.admit('retire', command.scopeId, credential);
    return this.mutate('retire', command, principal, authorization.revision, command.entryId, command.expectedRevision, previous =>
      retireMemoryEntry(previous!, { actor: principal, atMs: this.deps.now(), reason: command.reason, supersededBy: command.supersededBy }));
  }
  /** S4B-4 review card read (candidates, contested and stale entries with evidence and evaluator records), through the source filter. */
  async review(input: unknown, credential?: unknown): Promise<MemoryReview> {
    const query = memoryReviewQuerySchema.parse(input);
    return this.read(query.scopeId, credential, (store, principal) => reviewMemory(this.deps, store, principal, query, (...args) => this.visible(...args)));
  }
  /** S4B-4 §6.5: the entries derived from one Run or Attempt (`retire --source`, `purge --source`), through the source filter. */
  async sourceEntries(input: unknown, credential?: unknown): Promise<MemorySourceEntries> {
    const query = memorySourceQuerySchema.parse(input);
    return this.read(query.scopeId, credential, (store, principal) => memorySourceEntries(this.deps, store, principal, query, (...args) => this.visible(...args)));
  }
  /** S4B-4 §6.6 (A11): a person's purge of one entry — keyed tombstone, purge journal, evaluator invocation content. */
  async purge(input: unknown, credential?: unknown): Promise<MemoryPurgeResult> {
    return purgeMemoryEntry(this.deps, input, (action, scopeId) => this.admit(action, scopeId, credential));
  }
  /** S4B-4 A9: a person's resolution of one open contest. */
  async resolveContest(input: unknown, credential?: unknown): Promise<MemoryContestResolveResult> {
    return resolveMemoryContest(this.deps, input, (action, scopeId) => this.admit(action, scopeId, credential), command => this.retire(command, credential),
      (...args) => this.visible(...args));
  }
  /**
   * S4B-7 (§11): the rollout status of one scope — phase, every exit criterion with its measured numbers (counts only: no entry id, title or
   * digest leaves), the provisional retention values — under the caller's `memory`/`inspect`. Read-only: it enables nothing; a source that
   * cannot be read leaves its criteria unmet. Like every memory read (§6.6) it holds while a purge the journal holds is missing from the ledger.
   */
  async rollout(input: unknown, ports: MemoryRolloutPorts, credential?: unknown): Promise<MemoryRolloutStatus | MemoryHeld> {
    const query = memoryRolloutQuerySchema.parse(input);
    await this.admit('inspect', query.scopeId, credential);
    let store: MemoryJournalStore;
    try { store = await this.deps.openStore('read'); } catch (error) { return held(error); }
    try { await assertNoPendingMemoryPurge(this.deps, store, query.scopeId); return await measureMemoryRollout(this.deps, store, query.scopeId, query.modes, ports); }
    catch (error) { return held(error); } finally { store.close(); }
  }
  /** S4B-4 §6.6 restore safety: the scope's journal records re-applied (service start, and before a person's write). The authority is the sealed
   * journal record (a person's purge, already decided); the replay narrows only, so its events name the journal, not a policy rule. */
  async replayPurges(scopeId: string, credential?: unknown, options: { readonly pendingOnly?: boolean } = {}): Promise<MemoryPurgeReplay> {
    return replayMemoryPurges(this.deps, scopeId, await authenticate(this.deps.verifier, credential, scopeId), 'memory-purge-journal', options.pendingOnly ?? false);
  }
  private async mutate(action: 'propose' | 'verify' | 'retire', command: { scopeId: string; commandId: string }, principal: VerifiedPrincipal, policyRevision: string,
    entryId: string, expectedRevision: number | null, next: (previous: MemoryEntry | null, store: MemoryJournalStore) => MemoryEntry | Promise<MemoryEntry>,
    support?: MemorySupport, fingerprinted: unknown = command): Promise<MemoryMutationResult> {
    // S4B-1 §4.6: the receipt fingerprint covers content, so it is keyed (a receipt sealed before v65 keeps its plain digest and no longer replays).
    const digest = this.deps.keyedDigest(`memory-${action}:2`, { command: fingerprinted, principal: { issuer: principal.issuer, subject: principal.subject } });
    const store = await this.deps.openStore('write');
    try {
      await assertNoPendingMemoryPurge(this.deps, store, command.scopeId);
      const replay = await store.receipt(command.scopeId, command.commandId);
      if (replay) {
        const entry = replay.digest === digest && replay.entryId === entryId ? await store.loadRevision(command.scopeId, entryId, replay.revision) : null;
        if (!entry) throw new MemoryJournalError('MEMORY_COMMAND_CONFLICT');
        return { schemaVersion: 1, replayed: true, entry: inScope(entry, command.scopeId) };
      }
      const previous = expectedRevision === null ? null : await store.load(command.scopeId, entryId);
      if (expectedRevision !== null && !previous) throw new MemoryJournalError('MEMORY_NOT_FOUND');
      if (previous && previous.revision !== expectedRevision) throw new MemoryJournalError('MEMORY_REVISION_CONFLICT');
      const entry = await next(previous, store);
      const event: AuditEvent = { schemaVersion: 1, eventId: this.deps.eventId(), scopeId: command.scopeId, principal: { issuer: principal.issuer, subject: principal.subject },
        policyRevision, atMs: entry.updatedAtMs, subject: { kind: 'memory-journal', action, entryId: entry.entryId, commandId: command.commandId, revision: entry.revision,
          state: entry.state, contentDigest: entry.contentDigest, basis: entry.verification?.basis ?? null } };
      const saved = await store.commit({ previous, next: entry, receipt: { scopeId: command.scopeId, commandId: command.commandId, entryId, revision: entry.revision, digest }, event,
        ...(support ? { support } : {}) });
      return { schemaVersion: 1, replayed: saved.replayed, entry: saved.entry };
    } finally { store.close(); }
  }
}
