import { createHmac } from 'node:crypto';
import { MemoryJournalApplication, MemoryJournalError, PolicyAuthorizationError, type MemoryJournalStore, type MemorySupport } from '#engine/index.js';
import { memoryEntrySchema, type MemoryContest, type MemoryEntry, type MemoryState } from '#domain/index.js';

/** An in-memory memory journal for context selection tests (worker and Brain read the same engine selection). */
export const person = { id: 'h', issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user' as const, scopeIds: ['s', 'other'] };
export const kd = (label: string, value: unknown) => createHmac('sha256', 'test-key').update(`${label}\0${JSON.stringify(value)}`).digest('hex');
export const DAY = 86_400_000, NOW = 200 * DAY;
export type EntryOptions = { scopeId?: string; state?: MemoryState; basis?: 'human-review' | 'independent-evaluation'; audience?: { workClassFamily: string; workTargetId: string | null } | null;
  title?: string; body?: string; updatedAtMs?: number; purged?: boolean; proposedAtMs?: number };
export function entry(entryId: string, options: EntryOptions = {}): MemoryEntry {
  const state = options.state ?? 'verified', basis = options.basis ?? 'human-review', content = { kind: 'fact', title: options.title ?? `Kural ${entryId}`, body: options.body ?? 'İrsaliyesiz fatura onaya düşer.', tags: [], lesson: null };
  const digest = kd('memory-content:2', content);
  return memoryEntrySchema.parse({ schemaVersion: 2, scopeId: options.scopeId ?? 's', entryId, revision: state === 'candidate' ? 1 : 2, state,
    content: options.purged ? { purged: true, contentDigest: digest, digestKind: 'keyed', purgeRecordId: 'p1', reasonCode: 'personal-data' } : content, contentDigest: digest,
    provenance: { author: { issuer: 'local-os', subject: 'uid:1000', ai: options.audience ? true : false }, origin: { kind: options.audience ? 'run' : 'human', ref: null }, proposedAtMs: options.proposedAtMs ?? NOW - DAY, commandId: entryId },
    verification: state === 'candidate' ? null : basis === 'human-review' ? { basis, reviewer: { issuer: 'local-os', subject: 'uid:1000' }, note: 'ok', verifiedAtMs: NOW - DAY }
      : { basis, evaluator: { issuer: 'local-os/memory-evaluator', subject: 'uid:1000' }, record: { kind: 'memory-evaluation', id: 'r1', digest: 'b'.repeat(64) }, verifiedAtMs: NOW - DAY },
    retirement: state === 'retired' ? { by: { issuer: 'local-os', subject: 'uid:1000', ai: false }, reason: 'old', supersededBy: null, retiredAtMs: NOW - DAY } : null,
    updatedAtMs: options.updatedAtMs ?? NOW - DAY, audience: options.audience ?? null });
}
export const support = (entryId: string, attemptId: string, atMs = NOW - DAY): MemorySupport => ({ schemaVersion: 1, scopeId: 's', entryId, supportId: `${entryId}-${attemptId}`, producer: 'rule',
  source: { runId: 'r0', taskId: 't0', attemptId }, ruleId: 'E1', ruleVersion: 1, evaluationId: 'ev', evaluationDigest: 'c'.repeat(64), reportDigest: null, atMs });
export const contest = (entryId: string): MemoryContest => ({ schemaVersion: 1, contestId: `c-${entryId}`, scopeId: 's', entryId, candidateEntryId: 'm9', evaluationRecordId: 'r1',
  evaluationDigest: 'd'.repeat(64), openedBy: { issuer: 'local-os/memory-evaluator', subject: 'uid:1000' }, reasonCode: 'contradicts-verified', openedAtMs: NOW } as MemoryContest);
export class MemoryContextStore implements MemoryJournalStore {
  readonly capabilities = { fullTextSearch: true };
  failList = false; opened = 0;
  constructor(readonly entries: MemoryEntry[], readonly support: MemorySupport[] = [], readonly contests: MemoryContest[] = []) {}
  async load(scopeId: string, entryId: string) { return this.entries.find(row => row.scopeId === scopeId && row.entryId === entryId) ?? null; }
  async loadRevision() { return null; }
  async history() { return []; }
  async list(scopeId: string, states: readonly MemoryState[], limit: number) {
    if (this.failList) throw new MemoryJournalError('MEMORY_CORRUPT');
    return this.entries.filter(row => row.scopeId === scopeId && states.includes(row.state)).sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, limit);
  }
  async receipt() { return null; }
  async commit(): Promise<never> { throw new Error('read only'); }
  async listSupport(scopeId: string, entryId: string, limit: number) { return this.support.filter(row => row.scopeId === scopeId && row.entryId === entryId).slice(0, limit); }
  async listContests(scopeId: string, limit: number) { return this.contests.filter(row => row.scopeId === scopeId).slice(0, limit); }
  close() {}
}
export type ContextAppOptions = { inspect?: 'allow' | 'deny' | 'unavailable'; readable?: readonly string[]; overlay?: unknown; openFails?: boolean };
export function contextApp(store: MemoryContextStore, options: ContextAppOptions = {}) {
  return new MemoryJournalApplication({ verifier: { verify: async () => person },
    authorize: async () => { if (options.inspect === 'deny') throw new PolicyAuthorizationError('POLICY_DENIED');
      if (options.inspect === 'unavailable') throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); return { revision: 'p1', ruleId: 'memory' }; },
    readFilter: async () => (resource, action) => action === 'use' || (action === 'read-output' && (options.readable ?? ['a-read']).includes(resource.id)),
    openStore: async () => { if (options.openFails) throw new MemoryJournalError('MEMORY_UNAVAILABLE'); store.opened += 1; return store; }, keyedDigest: kd,
    automation: options.overlay, now: () => NOW, eventId: () => 'e1' });
}
