import { createHmac, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MemoryJournalApplication, MemoryJournalError, memoryExtractionSourceOf, memoryReportClaimsOf, type MemoryChange, type MemoryExtractionReceipt, type MemoryJournalDependencies, type MemoryJournalStore,
  type MemoryReceipt, type MemorySupport } from '#engine/index.js';
import { encodeCommandProjection, memoryDistillerPrincipal, memoryEntryMatches, type AuditEvent, type MemoryEntry, type MemoryState, type RunSnapshot, type TaskEvaluation } from '#domain/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';

// S4B-1 (S4B-DESIGN §4, §4.6, §7.4; owner S-M1/S-M2/S-M11 2026-10-23): system candidates from sealed evidence, keyed content digests, one entry per
// (scope, audience, content) with support rows, and the read-path source filter. The store is an in-memory implementation of the DB-neutral port.
const KEY = Buffer.alloc(32, 7);
const keyedDigest = (label: string, value: unknown) => createHmac('sha256', KEY).update(encodeCommandProjection(`memory-purge:1/${label}`, value)).digest('hex');
const human = { id: 'h', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['s', 'other'] };
const distiller = memoryDistillerPrincipal({ issuer: 'host', subject: '1000' }, ['s', 'other']);

class Store implements MemoryJournalStore {
  readonly capabilities = { fullTextSearch: true };
  rows = new Map<string, MemoryEntry[]>(); receipts = new Map<string, MemoryReceipt>(); events: AuditEvent[] = []; support: MemorySupport[] = [];
  extractions: MemoryExtractionReceipt[] = []; tombstones = new Set<string>();
  private key = (scopeId: string, id: string) => `${scopeId}\0${id}`;
  async load(scopeId: string, entryId: string) { return this.rows.get(this.key(scopeId, entryId))?.at(-1) ?? null; }
  async loadRevision(scopeId: string, entryId: string, revision: number) { return this.rows.get(this.key(scopeId, entryId))?.[revision - 1] ?? null; }
  async history(scopeId: string, entryId: string, limit: number) { return (this.rows.get(this.key(scopeId, entryId)) ?? []).slice(-limit); }
  async list(scopeId: string, states: readonly MemoryState[], limit: number) {
    return [...this.rows.values()].map(history => history.at(-1)!).filter(entry => entry.scopeId === scopeId && states.includes(entry.state)).slice(0, limit);
  }
  async search(scopeId: string, terms: readonly string[], states: readonly MemoryState[], limit: number) {
    return (await this.list(scopeId, states, 1000)).filter(entry => memoryEntryMatches(entry, terms)).slice(0, limit).map(entry => entry.entryId);
  }
  async receipt(scopeId: string, commandId: string) { return this.receipts.get(this.key(scopeId, commandId)) ?? null; }
  async commit(change: MemoryChange) {
    const key = this.key(change.next.scopeId, change.next.entryId), prior = this.receipts.get(this.key(change.receipt.scopeId, change.receipt.commandId));
    if (prior) { if (prior.digest !== change.receipt.digest) throw new MemoryJournalError('MEMORY_COMMAND_CONFLICT'); return { replayed: true, entry: (await this.loadRevision(prior.scopeId, prior.entryId, prior.revision))! }; }
    const history = this.rows.get(key) ?? [];
    if (!isDeepStrictEqual(history.at(-1) ?? null, change.previous)) throw new MemoryJournalError('MEMORY_REVISION_CONFLICT');
    this.rows.set(key, [...history, change.next]); this.receipts.set(this.key(change.receipt.scopeId, change.receipt.commandId), change.receipt); this.events.push(change.event);
    if (change.support) this.support.push(change.support);
    return { replayed: false, entry: change.next };
  }
  async appendSupport(support: MemorySupport) {
    if (this.support.some(row => row.scopeId === support.scopeId && row.supportId === support.supportId)) return { replayed: true };
    this.support.push(support); return { replayed: false };
  }
  async listSupport(scopeId: string, entryId: string, limit: number) { return this.support.filter(row => row.scopeId === scopeId && row.entryId === entryId).slice(0, limit); }
  async findTombstone(scopeId: string, contentDigest: string) { return this.tombstones.has(this.key(scopeId, contentDigest)); }
  async extractionReceipt(scopeId: string, source: { runId: string; taskId: string; attemptId: string }) {
    return this.extractions.find(row => row.scopeId === scopeId && row.source.runId === source.runId && row.source.taskId === source.taskId && row.source.attemptId === source.attemptId) ?? null;
  }
  async recordExtraction(receipt: MemoryExtractionReceipt) { if (await this.extractionReceipt(receipt.scopeId, receipt.source)) return { replayed: true }; this.extractions.push(receipt); return { replayed: false }; }
  async extractionCounts(scopeId: string, runId: string, sinceMs: number) {
    const rows = this.extractions.filter(row => row.scopeId === scopeId);
    return { run: rows.filter(row => row.source.runId === runId).reduce((sum, row) => sum + row.proposed, 0),
      scope: rows.filter(row => row.atMs >= sinceMs).reduce((sum, row) => sum + row.proposed, 0) };
  }
  positions = new Map<string, string>();
  async extractionCursor(scopeId: string) { return this.positions.get(scopeId) ?? null; }
  async advanceCursor(scopeId: string, position: string) { this.positions.set(scopeId, position); }
  close() {}
}
type Filter = NonNullable<MemoryJournalDependencies['readFilter']>;
function app(options: { store?: Store; principal?: typeof human; readFilter?: Filter | null; automation?: unknown; knownSecrets?: readonly string[] } = {}) {
  const store = options.store ?? new Store(); let clock = 1_000_000, ids = 0;
  const application = new MemoryJournalApplication({ verifier: { verify: async () => options.principal ?? human }, authorize: async () => ({ revision: 'p1', ruleId: 'r' }),
    openStore: async () => store, keyedDigest, now: () => clock++, eventId: () => `e${ids++}`,
    ...(options.readFilter === null ? {} : { readFilter: options.readFilter ?? (async () => () => true) }),
    ...(options.automation === undefined ? {} : { automation: options.automation }),
    ...(options.knownSecrets ? { knownSecrets: snapshotKnownSecrets(options.knownSecrets.map(value => ({ name: 'MEMORY_TEST_KEY', value }))) } : {}) });
  return { application, store };
}
const fact = (title = 'Masraf merkezi zorunlu') => ({ kind: 'fact', title, body: 'Tedarikçi faturasında masraf merkezi alanı boş geçilemez.', tags: [], lesson: null });
const audience = { workClassFamily: 'small', workTargetId: 'erp-test' };
const extract = (attemptId: string, content: unknown = fact(), extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, scopeId: 's', source: { runId: 'r1', taskId: 't1', attemptId },
  ruleId: 'E3', ruleVersion: 1, claimIndex: 0, content, audience,
  support: { producer: 'worker-claim', evaluationId: `ev-${attemptId}`, evaluationDigest: 'e'.repeat(64), reportDigest: 'f'.repeat(64) }, ...extra });
const source = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, scopeId: 's', runId: 'r1', taskId: 't1', attemptId: 'a2', generation: 2,
  workClass: { id: 'small', family: 'small', risk: 'low' }, workTargetId: 'erp-test', evaluation: { id: 'ev1', digest: 'e'.repeat(64) }, accepted: true, settled: true,
  inputAnswer: { question: 'Faturada masraf merkezi boşsa ne yapılmalı?', answer: 'Kayıt onay kuyruğuna gider; masraf merkezi atanmadan ERP kaydı yazılmaz.' },
  earlierFailure: null, lessons: null, reportDigest: null, ...overrides });

describe('keyed content digests (§4.6)', () => {
  it('a person\'s proposal is entry v2 with no audience and a keyed content digest (never the plain v1 SHA-256)', async () => {
    const { application, store } = app();
    const { entry } = await application.propose({ schemaVersion: 1, commandId: 'm1', scopeId: 's', content: fact(), origin: { kind: 'human', ref: null } });
    expect(entry).toMatchObject({ schemaVersion: 2, audience: null, entryId: 'm1' });
    expect(entry.contentDigest).toBe(keyedDigest('memory-content:2', fact()));
    expect(entry.contentDigest).not.toBe(createHash('sha256').update(encodeCommandProjection('memory-content:1', fact())).digest('hex'));
    expect(store.events[0]!.subject).toMatchObject({ kind: 'memory-journal', contentDigest: entry.contentDigest });
  });
});

describe('proposeExtracted: one entry per (scope, audience, content), support rows, replay (N13)', () => {
  it('the same content from two Attempts is one candidate with two support rows; a replay adds nothing; the id reveals no plain digest', async () => {
    const { application, store } = app({ principal: distiller });
    const first = await application.proposeExtracted(extract('a1')), second = await application.proposeExtracted(extract('a2'));
    expect(first).toMatchObject({ status: 'proposed', entry: { state: 'candidate', schemaVersion: 2, audience, provenance: { author: { issuer: 'host/memory-distiller', ai: true },
      origin: { kind: 'run', ref: 'run/r1/task/t1/attempt/a1' } } } });
    expect(first.entry.entryId).toBe(keyedDigest('memory-entry:2', { scopeId: 's', audience, content: fact() }));
    expect(second).toMatchObject({ status: 'supported', entry: { entryId: first.entry.entryId, revision: 1 } });
    expect(await application.proposeExtracted(extract('a2'))).toMatchObject({ status: 'replayed' });
    expect(store.rows.size).toBe(1); expect(store.support.map(row => row.source.attemptId)).toEqual(['a1', 'a2']);
    // Another audience is another entry (no within-scope merge across families or targets).
    const other = await application.proposeExtracted(extract('a3', fact(), { audience: { workClassFamily: 'small', workTargetId: null } }));
    expect(other.entry.entryId).not.toBe(first.entry.entryId);
  });
  it('retired content re-extracted stays retired (a support row is recorded); purged content is refused before any write', async () => {
    const { application, store } = app({ principal: distiller });
    const { entry } = await application.proposeExtracted(extract('a1'));
    await app({ store }).application.retire({ schemaVersion: 1, commandId: 'r', scopeId: 's', entryId: entry.entryId, expectedRevision: 1, reason: 'yanlış', supersededBy: null });
    expect(await application.proposeExtracted(extract('a2'))).toMatchObject({ status: 'supported', entry: { state: 'retired' } });
    store.tombstones.add(`s\0${keyedDigest('memory-content:2', fact('Silinmiş bilgi'))}`);
    await expect(application.proposeExtracted(extract('a4', fact('Silinmiş bilgi')))).rejects.toMatchObject({ code: 'MEMORY_PURGED_CONTENT' });
    expect(store.rows.size).toBe(1);
  });
  it('a store without the support port fails closed (no entry without its evidence)', async () => {
    const store = new Store(); (store as Partial<Store>).appendSupport = undefined;
    await expect(app({ store, principal: distiller }).application.proposeExtracted(extract('a1'))).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE' });
    expect(store.rows.size).toBe(0);
  });
});

describe('read-path source filter for list, search and inspect (§7.4, N25)', () => {
  it('a system entry is withheld from a caller without read-output on any source Attempt or without use of its work target; a person\'s entry needs only inspect', async () => {
    const store = new Store();
    const { entry } = await app({ store, principal: distiller }).application.proposeExtracted(extract('a1'));
    await app({ store }).application.propose({ schemaVersion: 1, commandId: 'm-human', scopeId: 's', content: fact('Kişinin notu masraf'), origin: { kind: 'human', ref: null } });
    const deny = (kind: string, id: string): Filter => async () => (resource, action) => !(resource.kind === kind && resource.id === id && (action === 'read-output' || action === 'use'));
    for (const filter of [deny('attempt', 'a1'), deny('work-target', 'erp-test')]) {
      const reader = app({ store, readFilter: filter }).application;
      const listed = await reader.list({ schemaVersion: 1, scopeId: 's', limit: 10 });
      expect(listed).toMatchObject({ status: 'ok', withheld: 1 });
      expect(listed.status === 'ok' && listed.entries.map(row => row.entryId)).toEqual(['m-human']);
      const found = await reader.search({ schemaVersion: 1, scopeId: 's', query: 'masraf', limit: 10 });
      expect(found).toMatchObject({ status: 'ok', withheld: 1, complete: true });
      expect(found.status === 'ok' && found.entries.map(row => row.entryId)).toEqual(['m-human']);
      await expect(reader.inspect({ schemaVersion: 1, scopeId: 's', entryId: entry.entryId })).rejects.toMatchObject({ code: 'MEMORY_ENTRY_WITHHELD' });
      expect(JSON.stringify(listed)).not.toContain(entry.entryId);
    }
    const allowed = app({ store }).application;
    expect(await allowed.list({ schemaVersion: 1, scopeId: 's', limit: 10 })).toMatchObject({ status: 'ok', withheld: 0 });
    expect(await allowed.inspect({ schemaVersion: 1, scopeId: 's', entryId: entry.entryId })).toMatchObject({ status: 'ok' });
    // No filter wired: every system entry is withheld (fail closed); the person's entry is still shown.
    expect(await app({ store, readFilter: null }).application.list({ schemaVersion: 1, scopeId: 's', limit: 10 })).toMatchObject({ withheld: 1, entries: [{ entryId: 'm-human' }] });
  });
});

describe('distil: rules, gate, screening, bounds (§4.1–§4.5)', () => {
  it('E1: an accepted Task whose earlier Attempt asked the person yields one lesson candidate; the same source again is a replay', async () => {
    const { application, store } = app({ principal: distiller });
    const outcome = await application.distil(source(), { mode: 'live' });
    expect(outcome).toMatchObject({ status: 'extracted', proposed: 1, refused: [], alerts: [] });
    const [entry] = [...store.rows.values()].map(rows => rows.at(-1)!);
    expect(entry).toMatchObject({ state: 'candidate', audience: { workClassFamily: 'small', workTargetId: 'erp-test' }, content: { kind: 'lesson',
      lesson: { cause: 'Faturada masraf merkezi boşsa ne yapılmalı?', correction: 'Kayıt onay kuyruğuna gider; masraf merkezi atanmadan ERP kaydı yazılmaz.' } } });
    expect(await application.distil(source(), { mode: 'live' })).toMatchObject({ status: 'replayed' });
    expect(store.rows.size).toBe(1); expect(store.extractions).toHaveLength(1);
  });
  it('N18/N7: no WorkClass row, a personal-data class, an unaccepted or unsettled source → no candidate (recorded as skipped)', async () => {
    for (const [override, reason] of [[{ workClass: { id: 'feature', family: 'feature', risk: 'normal' } }, 'work-class'], [{ workClass: null }, 'work-class'],
      [{ accepted: false }, 'not-accepted'], [{ settled: false }, 'not-accepted']] as const) {
      const { application, store } = app({ principal: distiller });
      expect(await application.distil(source(override), { mode: 'live' })).toMatchObject({ status: 'skipped', reason });
      expect(store.rows.size).toBe(0);
    }
    const overlay = { workClasses: [{ workClassId: 'docs', retentionProfile: { id: 'short', entryMaxAgeMs: 86_400_000 }, personalData: 'possible', extraction: true }] };
    const { application } = app({ principal: distiller, automation: overlay });
    expect(await application.distil(source({ workClass: { id: 'docs', family: 'docs', risk: 'low' } }), { mode: 'live' })).toMatchObject({ status: 'skipped', reason: 'work-class' });
  });
  it('N8: a known secret or a pattern secret refuses the candidate; hidden characters are quarantined; each is one alert', async () => {
    for (const [answer, code] of [['Anahtar: sk-live-TOPSECRET-VALUE-0001', 'MEMORY_CANDIDATE_SECRET'], [`Onay kuyruğu${String.fromCodePoint(0xe0069, 0xe0067, 0xe006e)}`, 'MEMORY_CANDIDATE_QUARANTINED']] as const) {
      const { application, store } = app({ principal: distiller, knownSecrets: ['sk-live-TOPSECRET-VALUE-0001'] });
      const outcome = await application.distil(source({ inputAnswer: { question: 'Hangi değer?', answer } }), { mode: 'live' });
      expect(outcome).toMatchObject({ status: 'extracted', proposed: 0, refused: [{ ruleId: 'E1', code }], alerts: [{ key: 'memory.alert.screening' }] });
      expect(store.rows.size).toBe(0);
    }
  });
  it('N12: past the per-Attempt bound the rest is refused with one alert, never truncated text; run and day bounds come from the registry', async () => {
    const claims = [1, 2, 3, 4].map(index => ({ kind: 'fact', title: `Kural ${index}`, body: `Gövde ${index}` }));
    const { application, store } = app({ principal: distiller });
    const outcome = await application.distil(source({ inputAnswer: null, lessons: claims, reportDigest: 'f'.repeat(64) }), { mode: 'live' });
    expect(outcome).toMatchObject({ proposed: 3, refused: [{ ruleId: 'E3', code: 'MEMORY_EXTRACTION_BOUND' }], alerts: [{ key: 'memory.alert.extractionBound' }] });
    expect(store.rows.size).toBe(3);
    const tight = app({ principal: distiller, automation: { bounds: { perRun: 1 } } });
    await tight.application.distil(source({ attemptId: 'a1' }), { mode: 'live' });
    expect(await tight.application.distil(source({ attemptId: 'a9', taskId: 't2' }), { mode: 'live' })).toMatchObject({ proposed: 0, refused: [{ code: 'MEMORY_EXTRACTION_BOUND' }] });
    // An overlay may only narrow: a wider bound is refused as unreadable registry data.
    await expect(app({ principal: distiller, automation: { bounds: { perAttempt: 99 } } }).application.distil(source(), { mode: 'live' })).rejects.toMatchObject({ code: 'MEMORY_AUTOMATION_INVALID' });
  });
  it('shadow mode records the receipt and proposes nothing; the distiller identity is required', async () => {
    const { application, store } = app({ principal: distiller });
    expect(await application.distil(source(), { mode: 'shadow' })).toMatchObject({ status: 'extracted', proposed: 0, shadow: 1 });
    expect(store.rows.size).toBe(0); expect(store.extractions).toHaveLength(1);
    await expect(app({ principal: human }).application.distil(source(), { mode: 'live' })).rejects.toMatchObject({ code: 'MEMORY_DISTILLER_REQUIRED' });
  });
});

describe('sealed source and the bounded page (§4.1)', () => {
  const identity = (attemptId: string, generation: number) => ({ scopeId: 's', runId: 'r1', taskId: 't1', attemptId, generation, layoutRevision: 'l' });
  const run = (phase: string, answerGeneration: number | null) => ({ identity: { scopeId: 's', runId: 'r1' }, bindings: [{ identity: identity('a2', 2) }],
    progress: [{ taskId: 't1', phase, ...(answerGeneration === null ? {} : { inputAnswer: { schemaVersion: 1, source: identity('a1', answerGeneration), question: 'Ne yapılmalı?', answer: 'Onaya gönder.' } }) }] });
  const evaluation = { evaluationId: 'ev-a2', identity: identity('a2', 2) };
  const of = (snapshot: unknown, overrides: Record<string, unknown> = {}) => memoryExtractionSourceOf({ run: snapshot as RunSnapshot, attemptId: 'a2', evaluations: [evaluation as unknown as TaskEvaluation],
    unsettledEffects: false, workClass: { id: 'small', family: 'small', risk: 'low' }, workTargetId: null, ...overrides });
  it('takes the person\'s answer only for the next generation, the evaluation digest from the sealed record, and acceptance from the Task phase', () => {
    expect(of(run('accepted', 1))).toMatchObject({ runId: 'r1', taskId: 't1', attemptId: 'a2', generation: 2, accepted: true, settled: true,
      inputAnswer: { question: 'Ne yapılmalı?', answer: 'Onaya gönder.' }, evaluation: { id: 'ev-a2', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }, lessons: null });
    expect(of(run('accepted', 0))?.inputAnswer).toBeNull();
    expect(of(run('running', 1))?.accepted).toBe(false);
    expect(of(run('accepted', 1), { unsettledEffects: true })?.settled).toBe(false);
    expect(of(run('accepted', 1), { evaluations: [] })).toBeNull();
    expect(of(run('accepted', 1), { attemptId: 'other' })).toBeNull();
  });
  it('pages after the durable position, passes over a row without a source, and refuses anyone but the distiller', async () => {
    const { application, store } = app({ principal: distiller }), asked: (string | null)[] = [];
    const page = async (after: string | null) => { asked.push(after); return after === null ? [{ position: '7', source: null }, { position: '9', source: source() }] : []; };
    expect(await application.distilPage('s', 'live', { page })).toMatchObject({ processed: 1, outcomes: [{ status: 'extracted', proposed: 1 }] });
    expect(await application.distilPage('s', 'live', { page })).toEqual({ processed: 0, outcomes: [] });
    expect(asked).toEqual([null, '9']); expect(store.rows.size).toBe(1);
    await expect(app({ principal: human, store }).application.distilPage('s', 'live', { page })).rejects.toMatchObject({ code: 'MEMORY_DISTILLER_REQUIRED' });
  });
});

describe('S4B-2 rule E3: the worker report\'s lesson claims are candidate input only (§4.2, §4.4)', () => {
  const identity = { scopeId: 's', runId: 'r1', taskId: 't1', attemptId: 'a2', generation: 2, layoutRevision: 'l' };
  const lessonClaim = { kind: 'lesson', title: 'Masraf merkezi', body: 'Fatura satırında boş geçilemez.', cause: 'Alan boştu', correction: 'Onay kuyruğuna gönder' };
  const sealed = (report: unknown, id = identity, completeness = 'complete') => {
    const stdout = JSON.stringify({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report }) + '\n';
    const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, identity: id, completeness, stdout, stderr: '' }));
    return { bytes, receipt: { byteLength: bytes.byteLength, digest: createHash('sha256').update(bytes).digest('hex') } };
  };
  const report = (lessons?: unknown) => ({ schemaVersion: 1, summary: 'ok', changedFiles: [], checks: [], openIssues: [], ...(lessons === undefined ? {} : { lessons }) });
  it('reads claims from the sealed envelope only when bytes, receipt and Attempt agree; no claim, invalid report or mismatch yields none', () => {
    const ok = sealed(report([lessonClaim]));
    expect(memoryReportClaimsOf(ok.receipt, ok.bytes, identity)).toMatchObject({ lessons: [lessonClaim], reportDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const none = sealed(report());
    expect(memoryReportClaimsOf(none.receipt, none.bytes, identity)).toBeNull();
    const invalid = sealed(report([{ kind: 'lesson', title: 't', body: 'b' }]));
    expect(memoryReportClaimsOf(invalid.receipt, invalid.bytes, identity)).toBeNull();
    expect(memoryReportClaimsOf({ ...ok.receipt, digest: 'a'.repeat(64) }, ok.bytes, identity)).toBeNull();
    expect(memoryReportClaimsOf(ok.receipt, ok.bytes, { ...identity, attemptId: 'other' })).toBeNull();
    const partial = sealed(report([lessonClaim]), identity, 'partial');
    expect(memoryReportClaimsOf(partial.receipt, partial.bytes, identity)).toBeNull();
  });
  const claims = { lessons: [lessonClaim, { kind: 'fact', title: 'Not', body: 'Tek satır bilgi.' }], reportDigest: 'c'.repeat(64) };
  const row = (overrides: Record<string, unknown> = {}) => [{ position: '3', source: source({ inputAnswer: null, ...overrides }) }];
  it('an accepted source with claims yields one candidate per claim (lesson and fact), claim-producer provenance and the report digest; the claims reach nobody else', async () => {
    const { application, store } = app({ principal: distiller });
    const outcome = await application.distilPage('s', 'live', { page: async after => after === null ? row() : [], report: async () => claims });
    expect(outcome).toMatchObject({ processed: 1, outcomes: [{ status: 'extracted', proposed: 2 }] });
    expect([...store.rows.values()].map(rows => rows.at(-1)!.content.kind).sort()).toEqual(['fact', 'lesson']);
    expect(store.support.map(support => support.producer)).toEqual(['worker-claim', 'worker-claim']);
    expect(store.support[0]).toMatchObject({ evaluationId: 'ev1', reportDigest: claims.reportDigest });
    expect([...store.rows.values()].every(rows => rows.at(-1)!.state === 'candidate')).toBe(true);
  });
  it('negative: an unaccepted or unsettled source never asks for the report and produces no candidate; a refused read (null) gives no E3 candidate and no error', async () => {
    for (const overrides of [{ accepted: false }, { settled: false }]) {
      const { application, store } = app({ principal: distiller }); let asked = 0;
      await application.distilPage('s', 'live', { page: async after => after === null ? row(overrides) : [], report: async () => { asked++; return claims; } });
      expect(asked).toBe(0); expect(store.rows.size).toBe(0);
    }
    const { application, store } = app({ principal: distiller });
    expect(await application.distilPage('s', 'live', { page: async after => after === null ? row() : [], report: async () => null })).toMatchObject({ processed: 1, outcomes: [{ status: 'extracted', proposed: 0 }] });
    expect(store.rows.size).toBe(0);
  });
  it('negative: secret-like claim text is refused by the §4.5 screening; a claim failing the entry bounds is refused as invalid, never coerced', async () => {
    const secret = 'sk-live-TOPSECRET-VALUE-0001';
    const { application, store } = app({ principal: distiller, knownSecrets: [secret] });
    const outcome = await application.distilPage('s', 'live', { page: async after => after === null ? row() : [], report: async () => ({ reportDigest: claims.reportDigest,
      lessons: [{ kind: 'fact', title: 'Anahtar', body: `Değer ${secret}` }, { kind: 'fact', title: 'Uzun', body: 'x'.repeat(100_000) }, claims.lessons[1]] }) });
    expect(outcome.outcomes[0]).toMatchObject({ proposed: 1, refused: [{ ruleId: 'E3', claimIndex: 0, code: 'MEMORY_CANDIDATE_SECRET' }, { ruleId: 'E3', claimIndex: 1, code: 'MEMORY_ENTRY_INVALID' }] });
    expect(store.rows.size).toBe(1);
  });
  it('the source builder carries claims from the report input and stays empty without one', () => {
    const run = { identity: { scopeId: 's', runId: 'r1' }, bindings: [{ identity }], progress: [{ taskId: 't1', phase: 'accepted' }] };
    const input = { run: run as unknown as RunSnapshot, attemptId: 'a2', evaluations: [{ evaluationId: 'ev', identity } as unknown as TaskEvaluation], unsettledEffects: false,
      workClass: { id: 'small', family: 'small', risk: 'low' as const }, workTargetId: null };
    expect(memoryExtractionSourceOf({ ...input, report: claims })).toMatchObject({ lessons: claims.lessons, reportDigest: claims.reportDigest });
    expect(memoryExtractionSourceOf(input)).toMatchObject({ lessons: null, reportDigest: null });
  });
});
