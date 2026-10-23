import { describe, expect, it } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { MemoryJournalApplication, MemoryJournalError, type MemoryJournalStore, type MemoryJournalDependencies, type MemoryChange, type MemoryReceipt } from '#engine/index.js';
import { memoryEntryMatches, type AuditEvent, type MemoryEntry, type MemoryState } from '#domain/index.js';

// S4 memory journal v1, engine contract. The store here is an in-memory implementation of the DB-neutral port (no SQL): the same application
// runs over the Core SQLite adapter or an Enterprise database adapter. A store without full-text search gets the bounded scan fallback.
const human = { id: 'h', issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user' as const, scopeIds: ['s', 'other'] };
const mcp = { id: 'm', issuer: 'local-os/mcp', subject: 'uid:1000', assurance: 'os-user' as const, scopeIds: ['s', 'other'] };
const content = { kind: 'fact', title: 'Fatura eşleştirme kuralı', body: 'İrsaliyesiz fatura onaya düşer.', tags: ['erp'], lesson: null };

class MemoryStore implements MemoryJournalStore {
  rows = new Map<string, MemoryEntry[]>(); receipts = new Map<string, MemoryReceipt>(); events: AuditEvent[] = []; failRead = false; dangling = false;
  constructor(readonly capabilities: { readonly fullTextSearch: boolean }) {}
  private key = (scopeId: string, id: string) => `${scopeId}\0${id}`;
  private check() { if (this.failRead) throw new MemoryJournalError('MEMORY_CORRUPT'); }
  async load(scopeId: string, entryId: string) { this.check(); return this.rows.get(this.key(scopeId, entryId))?.at(-1) ?? null; }
  async loadRevision(scopeId: string, entryId: string, revision: number) { return this.rows.get(this.key(scopeId, entryId))?.[revision - 1] ?? null; }
  async history(scopeId: string, entryId: string, limit: number) { this.check(); return (this.rows.get(this.key(scopeId, entryId)) ?? []).slice(-limit); }
  async list(scopeId: string, states: readonly MemoryState[], limit: number) {
    this.check(); return [...this.rows.values()].map(history => history.at(-1)!).filter(entry => entry.scopeId === scopeId && states.includes(entry.state))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, limit);
  }
  async search(scopeId: string, terms: readonly string[], states: readonly MemoryState[], limit: number) {
    if (this.dangling) return ['missing'];
    return (await this.list(scopeId, states, 1000)).filter(entry => memoryEntryMatches(entry, terms)).slice(0, limit).map(entry => entry.entryId);
  }
  async receipt(scopeId: string, commandId: string) { return this.receipts.get(this.key(scopeId, commandId)) ?? null; }
  async commit(change: MemoryChange) {
    const key = this.key(change.next.scopeId, change.next.entryId), prior = this.receipts.get(this.key(change.receipt.scopeId, change.receipt.commandId));
    if (prior) { if (prior.digest !== change.receipt.digest) throw new MemoryJournalError('MEMORY_COMMAND_CONFLICT'); return { replayed: true, entry: (await this.loadRevision(prior.scopeId, prior.entryId, prior.revision))! }; }
    const history = this.rows.get(key) ?? [];
    if (!isDeepStrictEqual(history.at(-1) ?? null, change.previous)) throw new MemoryJournalError('MEMORY_REVISION_CONFLICT');
    this.rows.set(key, [...history, change.next]); this.receipts.set(this.key(change.receipt.scopeId, change.receipt.commandId), change.receipt); this.events.push(change.event);
    return { replayed: false, entry: change.next };
  }
  close() {}
}
function app(options: { fullText?: boolean; principal?: typeof human; deny?: string[]; evaluation?: MemoryJournalDependencies['resolveEvaluation']; openFails?: boolean; store?: MemoryStore } = {}) {
  const store = options.store ?? new MemoryStore({ fullTextSearch: options.fullText ?? true }); let clock = 100, ids = 0;
  const application = new MemoryJournalApplication({ verifier: { verify: async () => options.principal ?? human },
    authorize: async action => { if (options.deny?.includes(action)) throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' }); return { revision: 'p1', ruleId: 'r' }; },
    openStore: async () => { if (options.openFails) throw new MemoryJournalError('MEMORY_UNAVAILABLE'); return store; },
    ...(options.evaluation ? { resolveEvaluation: options.evaluation } : {}), now: () => clock++, eventId: () => `e${ids++}` });
  return { application, store };
}
const propose = (commandId = 'm1', scopeId = 's', body = content) => ({ schemaVersion: 1, commandId, scopeId, content: body, origin: { kind: 'human', ref: null } });

describe('memory journal application (sole transition owner)', () => {
  it('proposes a candidate, records one sealed audit event per transition and replays the same command without a second write', async () => {
    const { application, store } = app();
    const first = await application.propose(propose());
    expect(first).toMatchObject({ replayed: false, entry: { entryId: 'm1', revision: 1, state: 'candidate', provenance: { author: { ai: false }, commandId: 'm1' } } });
    expect(first.entry.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await application.propose(propose())).toMatchObject({ replayed: true, entry: first.entry });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]!.subject).toMatchObject({ kind: 'memory-journal', action: 'propose', entryId: 'm1', revision: 1, state: 'candidate', basis: null });
    await expect(application.propose(propose('m1', 's', { ...content, title: 'other' }))).rejects.toMatchObject({ code: 'MEMORY_COMMAND_CONFLICT' });
  });
  it('a human verifies with a review; the AI (MCP actor) is refused and nothing is written', async () => {
    const { application, store } = app(); await application.propose(propose());
    await expect(app({ principal: mcp, store }).application.verify({ schemaVersion: 1, commandId: 'v1', scopeId: 's', entryId: 'm1', expectedRevision: 1, basis: { kind: 'human-review', note: 'mine' } }))
      .rejects.toMatchObject({ code: 'MEMORY_VERIFIER_NOT_HUMAN' });
    expect(store.events).toHaveLength(1);
    const verified = await application.verify({ schemaVersion: 1, commandId: 'v2', scopeId: 's', entryId: 'm1', expectedRevision: 1, basis: { kind: 'human-review', note: 'checked' } });
    expect(verified.entry).toMatchObject({ revision: 2, state: 'verified', verification: { basis: 'human-review' } });
    expect(store.events.at(-1)!.subject).toMatchObject({ action: 'verify', revision: 2, basis: 'human-review' });
  });
  it('an independent evaluation basis fails closed when no evaluation resolver is wired, and verifies through one that resolves a passing record', async () => {
    const basis = { kind: 'independent-evaluation', record: { kind: 'task-evaluation', id: 'r1/t1/a1', digest: 'b'.repeat(64) } };
    const closed = app(); await closed.application.propose(propose());
    await expect(closed.application.verify({ schemaVersion: 1, commandId: 'v', scopeId: 's', entryId: 'm1', expectedRevision: 1, basis }))
      .rejects.toMatchObject({ code: 'MEMORY_EVALUATION_UNAVAILABLE' });
    let digest = '';
    const open = app({ principal: mcp, evaluation: async (scopeId, record) => scopeId === 's' ? { record, evaluator: { issuer: 'deckent-evaluator', subject: 'exit' }, verdict: 'pass', subjectDigest: digest } : null });
    digest = (await open.application.propose(propose())).entry.contentDigest;
    expect((await open.application.verify({ schemaVersion: 1, commandId: 'v', scopeId: 's', entryId: 'm1', expectedRevision: 1, basis })).entry.state).toBe('verified');
  });
  it('a stale expected revision is a conflict, never a silent overwrite', async () => {
    const { application } = app(); await application.propose(propose());
    await expect(application.retire({ schemaVersion: 1, commandId: 'r', scopeId: 's', entryId: 'm1', expectedRevision: 2, reason: 'old', supersededBy: null }))
      .rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' });
    await expect(application.retire({ schemaVersion: 1, commandId: 'r2', scopeId: 's', entryId: 'absent', expectedRevision: 1, reason: 'old', supersededBy: null }))
      .rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
  });
  it('inspect shows the entry with its revision history; retirement keeps every revision (there is no delete)', async () => {
    const { application } = app(); await application.propose(propose());
    await application.retire({ schemaVersion: 1, commandId: 'r', scopeId: 's', entryId: 'm1', expectedRevision: 1, reason: 'wrong', supersededBy: null });
    const view = await application.inspect({ schemaVersion: 1, scopeId: 's', entryId: 'm1' });
    expect(view).toMatchObject({ status: 'ok', entry: { state: 'retired', revision: 2 } });
    expect(view.status === 'ok' && view.history.map(entry => entry.state)).toEqual(['candidate', 'retired']);
    expect(await application.inspect({ schemaVersion: 1, scopeId: 's', entryId: 'nope' })).toEqual({ schemaVersion: 1, status: 'not-found', entryId: 'nope' });
    expect(Object.getOwnPropertyNames(MemoryJournalApplication.prototype).filter(name => /delete|purge|remove/i.test(name))).toEqual([]);
  });
  it('search and list stay inside the requested scope (no cross-scope result)', async () => {
    const { application } = app(); await application.propose(propose('m1', 's')); await application.propose(propose('m2', 'other'));
    const found = await application.search({ schemaVersion: 1, scopeId: 's', query: 'fatura', limit: 10 });
    expect(found).toMatchObject({ status: 'ok', method: 'full-text', complete: true });
    expect(found.status === 'ok' && found.entries.map(entry => [entry.scopeId, entry.entryId])).toEqual([['s', 'm1']]);
    const listed = await application.list({ schemaVersion: 1, scopeId: 'other', limit: 10 });
    expect(listed.status === 'ok' && listed.entries.map(entry => entry.entryId)).toEqual(['m2']);
  });
  it('a store without full-text search falls back to a bounded scan with folded whole words, and says which method answered', async () => {
    const { application } = app({ fullText: false }); await application.propose(propose());
    const found = await application.search({ schemaVersion: 1, scopeId: 's', query: 'ESLESTIRME irsaliyesiz', limit: 10 });
    expect(found).toMatchObject({ status: 'ok', method: 'scan', complete: true, terms: ['eslestirme', 'irsaliyesiz'] });
    expect(found.status === 'ok' && found.entries).toHaveLength(1);
    const none = await application.search({ schemaVersion: 1, scopeId: 's', query: 'ankara', limit: 10 });
    expect(none.status === 'ok' && none.entries).toEqual([]);
  });
  it('a read failure holds instead of answering with an empty memory (store unavailable, corrupt row, index naming a missing entry)', async () => {
    const unavailable = app({ openFails: true });
    expect(await unavailable.application.list({ schemaVersion: 1, scopeId: 's', limit: 10 })).toEqual({ schemaVersion: 1, status: 'held', code: 'MEMORY_UNAVAILABLE' });
    const corrupt = app(); await corrupt.application.propose(propose()); corrupt.store.failRead = true;
    expect(await corrupt.application.search({ schemaVersion: 1, scopeId: 's', query: 'fatura', limit: 10 })).toEqual({ schemaVersion: 1, status: 'held', code: 'MEMORY_CORRUPT' });
    expect(await corrupt.application.inspect({ schemaVersion: 1, scopeId: 's', entryId: 'm1' })).toEqual({ schemaVersion: 1, status: 'held', code: 'MEMORY_CORRUPT' });
    const dangling = app(); await dangling.application.propose(propose()); dangling.store.dangling = true;
    expect(await dangling.application.search({ schemaVersion: 1, scopeId: 's', query: 'fatura', limit: 10 })).toEqual({ schemaVersion: 1, status: 'held', code: 'MEMORY_CORRUPT' });
  });
  it('a policy denial is a refusal, not a hold; an invalid query is refused before any read', async () => {
    const denied = app({ deny: ['inspect'] });
    await expect(denied.application.list({ schemaVersion: 1, scopeId: 's', limit: 10 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const { application } = app();
    await expect(application.search({ schemaVersion: 1, scopeId: 's', query: ' * " ', limit: 10 })).rejects.toMatchObject({ code: 'MEMORY_QUERY_INVALID' });
    await expect(application.list({ schemaVersion: 1, scopeId: 's', limit: 10_000 })).rejects.toThrow();
  });
});
