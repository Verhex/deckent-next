import { encodeCommandProjection, proposeMemoryEntry, verifyMemoryEntry, retireMemoryEntry, memorySearchTerms, memoryEntryMatches, MEMORY_LIMITS,
  type AuditEvent, type MemoryEntry, type MemoryState, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { authenticate } from '#engine/core/authentication/index.js';
import { memoryProposeCommandSchema, memoryVerifyCommandSchema, memoryRetireCommandSchema, memoryInspectQuerySchema, memoryListQuerySchema, memorySearchQuerySchema,
  MemoryJournalError, type MemoryAction, type MemoryHeld, type MemoryInspection, type MemoryJournalDependencies, type MemoryJournalStore, type MemoryListing,
  type MemoryMutationResult, type MemorySearchResult } from './contract.js';

const DEFAULT_STATES: readonly MemoryState[] = Object.freeze(['candidate', 'verified']);
const held = (error: unknown): MemoryHeld => ({ schemaVersion: 1, status: 'held',
  code: error instanceof MemoryJournalError && error.code === 'MEMORY_CORRUPT' ? 'MEMORY_CORRUPT' : 'MEMORY_UNAVAILABLE' });
const inScope = (entry: MemoryEntry, scopeId: string) => { if (entry.scopeId !== scopeId) throw new MemoryJournalError('MEMORY_CORRUPT'); return entry; };

/** Sole owner of memory journal transitions (one writer per scope through the store's compare-and-set). Reads hold on failure; nothing deletes. */
export class MemoryJournalApplication {
  constructor(private readonly deps: MemoryJournalDependencies) {}
  private async admit(action: MemoryAction, scopeId: string, credential?: unknown) {
    const principal = await authenticate(this.deps.verifier, credential, scopeId);
    return { principal, authorization: await this.deps.authorize(action, scopeId, principal) };
  }
  /** Authorization refusals throw; every failure after it (open, integrity, dangling index) becomes a typed hold. */
  private async read<T>(scopeId: string, credential: unknown, work: (store: MemoryJournalStore) => Promise<T>): Promise<T | MemoryHeld> {
    await this.admit('inspect', scopeId, credential);
    let store: MemoryJournalStore;
    try { store = await this.deps.openStore('read'); } catch (error) { return held(error); }
    try { return await work(store); } catch (error) { return held(error); } finally { store.close(); }
  }
  async inspect(input: unknown, credential?: unknown): Promise<MemoryInspection> {
    const query = memoryInspectQuerySchema.parse(input);
    return this.read(query.scopeId, credential, async store => {
      const entry = await store.load(query.scopeId, query.entryId);
      if (!entry) return { schemaVersion: 1 as const, status: 'not-found' as const, entryId: query.entryId };
      const history = (await store.history(query.scopeId, query.entryId, MEMORY_LIMITS.historyMax)).map(item => inScope(item, query.scopeId));
      if (inScope(entry, query.scopeId).entryId !== query.entryId || history.at(-1)?.revision !== entry.revision) throw new MemoryJournalError('MEMORY_CORRUPT');
      return { schemaVersion: 1 as const, status: 'ok' as const, entry, history };
    });
  }
  async list(input: unknown, credential?: unknown): Promise<MemoryListing> {
    const query = memoryListQuerySchema.parse(input), states = query.states ?? DEFAULT_STATES;
    return this.read(query.scopeId, credential, async store => {
      const entries = (await store.list(query.scopeId, states, query.limit)).slice(0, query.limit).map(entry => inScope(entry, query.scopeId));
      return { schemaVersion: 1 as const, status: 'ok' as const, scopeId: query.scopeId, entries };
    });
  }
  async search(input: unknown, credential?: unknown): Promise<MemorySearchResult> {
    const query = memorySearchQuerySchema.parse(input), states = query.states ?? DEFAULT_STATES, terms = memorySearchTerms(query.query);
    return this.read(query.scopeId, credential, async store => {
      const ok = { schemaVersion: 1 as const, status: 'ok' as const, scopeId: query.scopeId, terms };
      if (store.capabilities.fullTextSearch && store.search) {
        const entries: MemoryEntry[] = [];
        for (const id of (await store.search(query.scopeId, terms, states, query.limit)).slice(0, query.limit)) {
          const entry = await store.load(query.scopeId, id);
          // An index naming an entry the journal does not hold is an integrity failure, never a silently shorter answer.
          if (!entry || !states.includes(inScope(entry, query.scopeId).state)) throw new MemoryJournalError('MEMORY_CORRUPT');
          entries.push(entry);
        }
        return { ...ok, method: 'full-text' as const, complete: true, entries };
      }
      const scanned = (await store.list(query.scopeId, states, MEMORY_LIMITS.scanMax + 1)).map(entry => inScope(entry, query.scopeId));
      return { ...ok, method: 'scan' as const, complete: scanned.length <= MEMORY_LIMITS.scanMax,
        entries: scanned.slice(0, MEMORY_LIMITS.scanMax).filter(entry => memoryEntryMatches(entry, terms)).slice(0, query.limit) };
    });
  }
  async propose(input: unknown, credential?: unknown): Promise<MemoryMutationResult> {
    const command = memoryProposeCommandSchema.parse(input), { principal, authorization } = await this.admit('propose', command.scopeId, credential);
    return this.mutate('propose', command, principal, authorization.revision, command.commandId, null, () => proposeMemoryEntry({ scopeId: command.scopeId,
      entryId: command.commandId, commandId: command.commandId, content: command.content, origin: command.origin, author: principal, atMs: this.deps.now(),
      contentDigest: sha256(encodeCommandProjection('memory-content:1', command.content)) }));
  }
  async verify(input: unknown, credential?: unknown): Promise<MemoryMutationResult> {
    const command = memoryVerifyCommandSchema.parse(input), { principal, authorization } = await this.admit('verify', command.scopeId, credential);
    return this.mutate('verify', command, principal, authorization.revision, command.entryId, command.expectedRevision, async previous => {
      const evaluation = command.basis.kind === 'independent-evaluation' ? await this.deps.resolveEvaluation?.(command.scopeId, command.basis.record) ?? null : null;
      return verifyMemoryEntry(previous!, { actor: principal, atMs: this.deps.now(), basis: command.basis, evaluation });
    });
  }
  async retire(input: unknown, credential?: unknown): Promise<MemoryMutationResult> {
    const command = memoryRetireCommandSchema.parse(input), { principal, authorization } = await this.admit('retire', command.scopeId, credential);
    return this.mutate('retire', command, principal, authorization.revision, command.entryId, command.expectedRevision, previous =>
      retireMemoryEntry(previous!, { actor: principal, atMs: this.deps.now(), reason: command.reason, supersededBy: command.supersededBy }));
  }
  private async mutate(action: 'propose' | 'verify' | 'retire', command: { scopeId: string; commandId: string }, principal: VerifiedPrincipal, policyRevision: string,
    entryId: string, expectedRevision: number | null, next: (previous: MemoryEntry | null) => MemoryEntry | Promise<MemoryEntry>): Promise<MemoryMutationResult> {
    const digest = sha256(encodeCommandProjection(`memory-${action}:1`, { command, principal: { issuer: principal.issuer, subject: principal.subject } }));
    const store = await this.deps.openStore('write');
    try {
      const replay = await store.receipt(command.scopeId, command.commandId);
      if (replay) {
        const entry = replay.digest === digest && replay.entryId === entryId ? await store.loadRevision(command.scopeId, entryId, replay.revision) : null;
        if (!entry) throw new MemoryJournalError('MEMORY_COMMAND_CONFLICT');
        return { schemaVersion: 1, replayed: true, entry: inScope(entry, command.scopeId) };
      }
      const previous = expectedRevision === null ? null : await store.load(command.scopeId, entryId);
      if (expectedRevision !== null && !previous) throw new MemoryJournalError('MEMORY_NOT_FOUND');
      if (previous && previous.revision !== expectedRevision) throw new MemoryJournalError('MEMORY_REVISION_CONFLICT');
      const entry = await next(previous);
      const event: AuditEvent = { schemaVersion: 1, eventId: this.deps.eventId(), scopeId: command.scopeId, principal: { issuer: principal.issuer, subject: principal.subject },
        policyRevision, atMs: entry.updatedAtMs, subject: { kind: 'memory-journal', action, entryId: entry.entryId, commandId: command.commandId, revision: entry.revision,
          state: entry.state, contentDigest: entry.contentDigest, basis: entry.verification?.basis ?? null } };
      const saved = await store.commit({ previous, next: entry, receipt: { scopeId: command.scopeId, commandId: command.commandId, entryId, revision: entry.revision, digest }, event });
      return { schemaVersion: 1, replayed: saved.replayed, entry: saved.entry };
    } finally { store.close(); }
  }
}
