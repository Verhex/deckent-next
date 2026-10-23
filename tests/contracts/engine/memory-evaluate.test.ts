import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MemoryEvaluationApplication, MemoryJournalApplication, MemoryJournalError, memoryEvaluationDigest, memoryEvaluationResolver, type MemoryChange, type MemoryEvaluationSource,
  type MemoryEvaluatorCall, type MemoryEvaluatorRow, type MemoryJournalStore, type MemoryReceipt, type MemorySupport } from '#engine/index.js';
import { encodeCommandProjection, memoryDistillerPrincipal, memoryEntryMatches, memoryEvaluatorPrincipal, type AuditEvent, type MemoryContest, type MemoryEntry,
  type MemoryEvaluationRecord, type MemoryState } from '#domain/index.js';

// S4B-3 (S4B-DESIGN rev 4 §6, owner S-M3/S-M4/S-M5/S-M10 2026-10-23): the evaluator pass over fixture ports only — an in-memory store of the DB-neutral port,
// fixture sealed sources and a fixture provider (no paid API is ever called). Makers and models are synthetic; no model name decides anything.
const KEY = Buffer.alloc(32, 9);
const keyedDigest = (label: string, value: unknown) => createHmac('sha256', KEY).update(encodeCommandProjection(`memory-purge:1/${label}`, value)).digest('hex');
const owner = { issuer: 'host', subject: '1000' };
const distiller = memoryDistillerPrincipal(owner, ['s']), evaluator = memoryEvaluatorPrincipal(owner, ['s']);

class Store implements MemoryJournalStore {
  readonly capabilities = { fullTextSearch: true };
  rows = new Map<string, MemoryEntry[]>(); receipts = new Map<string, MemoryReceipt>(); events: AuditEvent[] = []; support: MemorySupport[] = [];
  evaluations: { record: MemoryEvaluationRecord; digest: string }[] = []; contests: MemoryContest[] = [];
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
    if (prior) return { replayed: true, entry: (await this.loadRevision(prior.scopeId, prior.entryId, prior.revision))! };
    const history = this.rows.get(key) ?? [];
    if (!isDeepStrictEqual(history.at(-1) ?? null, change.previous)) throw new MemoryJournalError('MEMORY_REVISION_CONFLICT');
    this.rows.set(key, [...history, change.next]); this.receipts.set(this.key(change.receipt.scopeId, change.receipt.commandId), change.receipt); this.events.push(change.event);
    if (change.support) this.support.push(change.support);
    return { replayed: false, entry: change.next };
  }
  async appendSupport(support: MemorySupport) { this.support.push(support); return { replayed: false }; }
  async listSupport(scopeId: string, entryId: string, limit: number) { return this.support.filter(row => row.scopeId === scopeId && row.entryId === entryId).slice(0, limit); }
  async findTombstone() { return false; }
  async putEvaluation(record: MemoryEvaluationRecord, digest: string, event: AuditEvent) {
    const prior = this.evaluations.find(row => row.record.scopeId === record.scopeId && row.record.recordId === record.recordId);
    if (prior) { if (prior.digest !== digest) throw new MemoryJournalError('MEMORY_COMMAND_CONFLICT'); return { replayed: true }; }
    this.evaluations.push({ record, digest }); this.events.push(event); return { replayed: false };
  }
  async loadEvaluation(scopeId: string, recordId: string) { return this.evaluations.find(row => row.record.scopeId === scopeId && row.record.recordId === recordId) ?? null; }
  async recentEvaluations(scopeId: string, limit: number) { return this.evaluations.filter(row => row.record.scopeId === scopeId).map(row => row.record).reverse().slice(0, limit); }
  async openContest(contest: MemoryContest, event: AuditEvent) {
    if (this.contests.some(row => row.contestId === contest.contestId)) return { replayed: true };
    this.contests.push(contest); this.events.push(event); return { replayed: false };
  }
  async contestCount(scopeId: string, sinceMs: number) { return this.contests.filter(row => row.scopeId === scopeId && row.openedAtMs >= sinceMs).length; }
  close() {}
}
const fact = (title: string, body = 'Tedarikçi faturasında masraf merkezi alanı boş geçilemez.') => ({ kind: 'fact', title, body, tags: [], lesson: null });
const sourceOf = (models: MemoryEvaluationSource['models'], extra: Partial<MemoryEvaluationSource> = {}): MemoryEvaluationSource =>
  ({ accepted: true, settled: true, evaluationId: 'ev1', criteria: [{ criterionId: 'c1', status: 'passed' }], models, ...extra });
const workerA = [{ channelId: 'channel-a', modelId: 'model-a', maker: 'maker-a' }];
const row = (channelId: string, maker: string | null, billing: MemoryEvaluatorRow['billing'] = 'metered', invocable = true): MemoryEvaluatorRow =>
  ({ channelId, modelId: `${channelId}-model`, maker, billing, invocable });
type Answer = (request: { messages: readonly { role: string; content: string }[]; row: MemoryEvaluatorRow }) => MemoryEvaluatorCall;
const echo = (verdict: string, extra: object = {}): Answer => request => {
  const data = JSON.parse(request.messages[1]!.content) as { entryId: string; subjectDigest: string };
  return { status: 'responded', invocationId: `inv-${data.entryId.slice(0, 8)}`, spend: { state: 'none' },
    text: JSON.stringify({ schemaVersion: 1, entryId: data.entryId, subjectDigest: data.subjectDigest, verdict, reasonCodes: ['supported'], conflicts: [], ...extra }) };
};
function fixture(options: { rows?: readonly MemoryEvaluatorRow[]; sources?: Record<string, MemoryEvaluationSource | null>; answer?: Answer; automation?: unknown } = {}) {
  const store = new Store(), calls: { row: MemoryEvaluatorRow; messages: readonly { role: string; content: string }[] }[] = [];
  let clock = 86_400_000 * 20_000, ids = 0;
  const sources = { async source(_scope: string, attempt: { attemptId: string }) { return options.sources?.[attempt.attemptId] === undefined ? sourceOf(workerA) : options.sources[attempt.attemptId]!; } };
  const base = { authorize: async () => ({ revision: 'p1', ruleId: 'r' }), openStore: async () => store, keyedDigest, now: () => clock++, eventId: () => `e${ids++}`,
    ...(options.automation === undefined ? {} : { automation: options.automation }) };
  const writer = new MemoryJournalApplication({ ...base, verifier: { verify: async () => distiller } });
  const journal = new MemoryJournalApplication({ ...base, verifier: { verify: async () => evaluator }, resolveEvaluation: memoryEvaluationResolver(base.openStore), evaluationSources: sources });
  const application = new MemoryEvaluationApplication({ deps: { ...base, verifier: { verify: async () => evaluator }, evaluationSources: sources }, principal: evaluator,
    verify: command => journal.verify(command),
    evaluator: { rows: async () => options.rows ?? [row('channel-b', 'maker-b')], invoke: async request => { calls.push(request); return (options.answer ?? echo('pass'))(request); } } });
  const propose = (attemptId: string, title: string, body?: string) => writer.proposeExtracted({ schemaVersion: 1, scopeId: 's', source: { runId: 'r1', taskId: 't1', attemptId },
    ruleId: 'E3', ruleVersion: 1, claimIndex: 0, content: fact(title, body), audience: { workClassFamily: 'small', workTargetId: null },
    support: { producer: 'worker-claim', evaluationId: `ev-${attemptId}`, evaluationDigest: 'e'.repeat(64), reportDigest: null } });
  return { store, calls, application, journal, propose, nextDay: () => { clock += 86_400_000; } };
}

describe('shadow first: the record is sealed, the entry stays a candidate', () => {
  it('shadow seals one record from one call and verifies nothing; the shadow record is never a basis; it is never asked again', async () => {
    const f = fixture(), { entry } = await f.propose('a1', 'Masraf merkezi zorunlu');
    const pass = await f.application.evaluatePage('s', 'shadow');
    expect(pass).toMatchObject({ mode: 'shadow', calls: 1, records: [{ entryId: entry.entryId, verdict: 'pass', verified: false, contests: 0 }], alerts: [] });
    expect((await f.store.load('s', entry.entryId))!.state).toBe('candidate');
    const [sealed] = f.store.evaluations;
    expect(sealed!.record).toMatchObject({ mode: 'shadow', subjectDigest: entry.contentDigest, evaluator: { issuer: evaluator.issuer }, evaluatorModel: { maker: 'maker-b' },
      sourceModels: workerA, template: { id: 'evaluate', version: 1 }, spend: { state: 'none' } });
    expect(JSON.stringify(sealed!.record)).not.toContain('Masraf');
    expect(f.store.events.at(-1)!.subject).toMatchObject({ kind: 'memory-evaluation', mode: 'shadow', verdict: 'pass', recordDigest: sealed!.digest });
    await expect(f.journal.verify({ schemaVersion: 1, scopeId: 's', commandId: 'v1', entryId: entry.entryId, expectedRevision: 1,
      basis: { kind: 'independent-evaluation', record: { kind: 'memory-evaluation', id: sealed!.record.recordId, digest: sealed!.digest } } })).rejects.toMatchObject({ code: 'MEMORY_EVALUATION_UNAVAILABLE' });
    expect(await f.application.evaluatePage('s', 'shadow')).toMatchObject({ calls: 0, skipped: [{ entryId: entry.entryId, reason: 'evaluated' }] });
    expect(f.calls).toHaveLength(1);
  });
  it('live verifies a pass through the journal (basis independent-evaluation by the evaluator); a sealed but unapplied pass is applied without a second call (N20)', async () => {
    const f = fixture(), { entry } = await f.propose('a1', 'Masraf merkezi zorunlu');
    expect(await f.application.evaluatePage('s', 'live')).toMatchObject({ calls: 1, records: [{ verdict: 'pass', verified: true }] });
    const verified = (await f.store.load('s', entry.entryId))!;
    expect(verified.verification).toMatchObject({ basis: 'independent-evaluation', evaluator: { issuer: evaluator.issuer, subject: evaluator.subject },
      record: { kind: 'memory-evaluation', id: f.store.evaluations[0]!.record.recordId, digest: memoryEvaluationDigest(f.store.evaluations[0]!.record) } });
    const crashed = fixture(), second = await crashed.propose('a1', 'Masraf merkezi zorunlu');
    const verify = crashed.application['ports'].verify; let calls = 0;
    (crashed.application['ports'] as { verify: typeof verify }).verify = async () => { calls++; throw new Error('CRASH_AFTER_SEAL'); };
    await expect(crashed.application.evaluatePage('s', 'live')).rejects.toThrow('CRASH_AFTER_SEAL');
    (crashed.application['ports'] as { verify: typeof verify }).verify = verify;
    expect(await crashed.application.evaluatePage('s', 'live')).toMatchObject({ calls: 0, records: [{ verified: true }] });
    expect(crashed.calls).toHaveLength(1); expect(calls).toBe(1); expect((await crashed.store.load('s', second.entry.entryId))!.state).toBe('verified');
  });
});

describe('independence and selection (N29, N30, subscription first)', () => {
  it('N29: only the source maker connected → no call, no record, the entry stays a candidate', async () => {
    const f = fixture({ rows: [row('channel-a2', 'maker-a', 'subscription'), row('channel-a3', 'maker-a')] }), { entry } = await f.propose('a1', 'Bir');
    expect(await f.application.evaluatePage('s', 'live')).toMatchObject({ calls: 0, records: [], skipped: [{ entryId: entry.entryId, reason: 'no-independent-evaluator' }] });
    expect(f.calls).toEqual([]); expect(f.store.evaluations).toEqual([]);
  });
  it('N30: a source of unknown maker (provider-chosen) is never evaluated; an evaluator row of unknown maker or without an invocation path is never chosen', async () => {
    const unknown = fixture({ sources: { a1: sourceOf([{ channelId: 'channel-auto', modelId: 'auto', maker: null }]) } });
    await unknown.propose('a1', 'Bir');
    expect(await unknown.application.evaluatePage('s', 'live')).toMatchObject({ calls: 0, skipped: [{ reason: 'maker-unknown' }] });
    const rows = fixture({ rows: [row('channel-x', null, 'subscription'), row('channel-y', 'maker-y', 'subscription', false)] }); await rows.propose('a1', 'Bir');
    expect(await rows.application.evaluatePage('s', 'live')).toMatchObject({ calls: 0, skipped: [{ reason: 'no-independent-evaluator' }] });
  });
  it('subscription channels first, then registry order; only `memory-evaluator` rows of the role port are ever invoked (N3)', async () => {
    const f = fixture({ rows: [row('channel-m', 'maker-m', 'metered'), row('channel-sub', 'maker-s', 'subscription')] }); await f.propose('a1', 'Bir');
    await f.application.evaluatePage('s', 'shadow');
    expect(f.calls.map(call => call.row.channelId)).toEqual(['channel-sub']);
    expect(f.calls[0]!.messages[0]!.role).toBe('system'); expect(f.calls[0]!.messages[0]!.content).not.toContain('Bir');
  });
  it('N7: a source no longer accepted or settled, or gone, means no call', async () => {
    for (const source of [sourceOf(workerA, { accepted: false }), sourceOf(workerA, { settled: false }), null]) {
      const f = fixture({ sources: { a1: source } }); await f.propose('a1', 'Bir');
      expect(await f.application.evaluatePage('s', 'live')).toMatchObject({ calls: 0, skipped: [{ reason: 'source-not-accepted' }] });
    }
  });
  it('N22: a record whose source models differ from the set re-derived from the sealed Runs is refused at verify', async () => {
    const f = fixture(), { entry } = await f.propose('a1', 'Bir');
    await f.application.evaluatePage('s', 'shadow');
    const forged = { ...f.store.evaluations[0]!.record, recordId: 'forged', mode: 'live' as const, sourceModels: [{ channelId: 'channel-c', modelId: 'model-c', maker: 'maker-c' }] };
    f.store.evaluations.push({ record: forged, digest: memoryEvaluationDigest(forged) });
    await expect(f.journal.verify({ schemaVersion: 1, scopeId: 's', commandId: 'v1', entryId: entry.entryId, expectedRevision: 1,
      basis: { kind: 'independent-evaluation', record: { kind: 'memory-evaluation', id: 'forged', digest: memoryEvaluationDigest(forged) } } })).rejects.toMatchObject({ code: 'MEMORY_EVALUATION_NOT_INDEPENDENT' });
  });
});

describe('bounded spend, unknown answers and contests (N16, N26, N33)', () => {
  it('N16: free text is a sealed unknown, never re-asked; the unknown breaker stops the pass with one alert', async () => {
    const f = fixture({ answer: () => ({ status: 'responded', text: 'I think this is fine.', invocationId: 'i', spend: { state: 'none' } }), automation: { evaluation: { unknownPerScopePerDay: 2 } } });
    for (const title of ['Bir', 'İki', 'Üç']) await f.propose(`a-${title}`, title);
    expect(await f.application.evaluatePage('s', 'live')).toMatchObject({ calls: 2, alerts: [{ key: 'memory.alert.evaluatorBreaker', scopeId: 's' }] });
    expect(f.store.evaluations.map(row => [row.record.verdict, row.record.failure])).toEqual([['unknown', 'MEMORY_EVALUATION_ANSWER_INVALID'], ['unknown', 'MEMORY_EVALUATION_ANSWER_INVALID']]);
  });
  it('N33: the daily call cap and the settled spend cap stop the evaluator with one alert each; unknown spend stops it too', async () => {
    const capped = fixture({ automation: { evaluation: { perScopePerDay: 1 } } });
    await capped.propose('a1', 'Bir'); await capped.propose('a2', 'İki');
    expect(await capped.application.evaluatePage('s', 'shadow')).toMatchObject({ calls: 1, alerts: [{ key: 'memory.alert.evaluationDailyCap' }] });
    const spent = fixture({ automation: { evaluation: { spendMinorUnitsPerScopePerDay: 10 } },
      answer: request => ({ ...echo('fail')(request), spend: { state: 'settled', minorUnits: 10, currency: 'USD' } }) as MemoryEvaluatorCall });
    await spent.propose('a1', 'Bir'); await spent.propose('a2', 'İki');
    expect(await spent.application.evaluatePage('s', 'shadow')).toMatchObject({ calls: 1, alerts: [{ key: 'memory.alert.spendCap' }] });
    const unknownSpend = fixture({ answer: request => ({ ...echo('fail')(request), spend: { state: 'unknown' } }) as MemoryEvaluatorCall });
    await unknownSpend.propose('a1', 'Bir'); await unknownSpend.propose('a2', 'İki');
    expect(await unknownSpend.application.evaluatePage('s', 'shadow')).toMatchObject({ calls: 1, alerts: [{ key: 'memory.alert.spendCap' }] });
  });
  it('N26: a live pass listing a verified conflict opens one contest (bounded per day); a fail never does; shadow opens none', async () => {
    const offered = (verdict: string): Answer => request => {
      const data = JSON.parse(request.messages[1]!.content) as { verifiedTitles: { entryId: string }[] };
      return echo(verdict, { conflicts: data.verifiedTitles.map(item => item.entryId), reasonCodes: ['contradicts-verified'] })(request);
    };
    for (const [verdict, mode, expected] of [['pass', 'live', 1], ['fail', 'live', 0], ['pass', 'shadow', 0]] as const) {
      const f = fixture({ answer: offered(verdict), automation: { evaluation: { contestsPerScopePerDay: 1 } } });
      const old = await f.propose('a0', 'Masraf merkezi zorunlu');
      // The person verifies the older entry through their own journal (a human review needs a human actor) over the same store.
      const person = new MemoryJournalApplication({ verifier: { verify: async () => ({ id: 'p', ...owner, assurance: 'os-user' as const, scopeIds: ['s'] }) },
        authorize: async () => ({ revision: 'p1', ruleId: 'r' }), openStore: async () => f.store, keyedDigest, now: () => 1, eventId: () => 'ep' });
      await person.verify({ schemaVersion: 1, scopeId: 's', commandId: 'human', entryId: old.entry.entryId, expectedRevision: 1, basis: { kind: 'human-review', note: 'ok' } });
      await f.propose('a1', 'Masraf merkezi zorunlu değil', 'Tedarikçi faturasında masraf merkezi alanı boş bırakılabilir.');
      await f.application.evaluatePage('s', mode);
      expect(f.store.contests.length, `${verdict}/${mode}`).toBe(expected);
      if (expected) expect(f.store.contests[0]).toMatchObject({ entryId: old.entry.entryId, reasonCode: 'contradicts-verified', openedBy: { issuer: evaluator.issuer } });
      expect((await f.store.load('s', old.entry.entryId))!.state).toBe('verified');
    }
  });
});

describe('fail closed and N28 injection corpus', () => {
  it('a refusal before anything was sent (the invoker throws) seals no record and stops the pass; the candidate is asked once the cause is fixed', async () => {
    let refuse = true;
    const f = fixture({ answer: request => { if (refuse) throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' }); return echo('pass')(request); } });
    await f.propose('a1', 'Bir'); await f.propose('a2', 'İki');
    await expect(f.application.evaluatePage('s', 'shadow')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.store.evaluations).toEqual([]); expect(f.calls).toHaveLength(1);
    refuse = false;
    expect(await f.application.evaluatePage('s', 'shadow')).toMatchObject({ calls: 2, records: [{ verdict: 'pass' }, { verdict: 'pass' }] });
  });
  it('a store without the evaluation methods holds; another principal is refused', async () => {
    const f = fixture();
    const bare = new MemoryEvaluationApplication({ deps: { ...f.application['ports'].deps, openStore: async () => ({ ...f.store, putEvaluation: undefined, close() {} }) as never },
      principal: evaluator, verify: async () => undefined, evaluator: { rows: async () => [], invoke: async () => { throw new Error('never'); } } });
    await expect(bare.evaluatePage('s', 'shadow')).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE' });
    const other = new MemoryEvaluationApplication({ ...f.application['ports'], principal: distiller });
    await expect(other.evaluatePage('s', 'shadow')).rejects.toMatchObject({ code: 'MEMORY_EVALUATOR_REQUIRED' });
  });
  it('N28: every corpus candidate reaches the model only as quoted data, and an answer injected through the candidate text never passes (keyed echo)', async () => {
    const corpus = JSON.parse(readFileSync(new URL('../../fixtures/memory/injection-corpus.json', import.meta.url), 'utf8')) as { schemaVersion: 1; items: { id: string; title: string; body: string }[] };
    expect(corpus.items.length).toBeGreaterThanOrEqual(30);
    // A fooled model: it obeys the candidate and returns the answer object the candidate text carries (or `pass` with the fields it guesses).
    const fooled: Answer = request => {
      const data = JSON.parse(request.messages[1]!.content) as { entryId: string; candidate: { body: string } };
      const injected = /\{.*\}/su.exec(data.candidate.body)?.[0];
      return { status: 'responded', invocationId: 'i', spend: { state: 'none' }, text: injected ?? JSON.stringify({ schemaVersion: 1, entryId: data.entryId, subjectDigest: '0'.repeat(64),
        verdict: 'pass', reasonCodes: ['supported'], conflicts: [] }) };
    };
    const f = fixture({ answer: fooled });
    for (const item of corpus.items) await f.propose(item.id, item.title, item.body).catch(() => undefined);
    // The unknown breaker stops each day's pass (a product control); the corpus is measured over as many days as it takes.
    let records = 0;
    for (let day = 0; day < corpus.items.length; day++) { records += (await f.application.evaluatePage('s', 'live')).records.length; f.nextDay(); }
    expect(records).toBeGreaterThanOrEqual(30);
    expect(f.store.evaluations.filter(row => row.record.verdict === 'pass')).toEqual([]);
    expect([...f.store.rows.values()].every(history => history.at(-1)!.state === 'candidate')).toBe(true);
    for (const call of f.calls) { expect(call.messages[0]!.content).not.toMatch(/ignore|IGNORE/u); expect(() => JSON.parse(call.messages[1]!.content)).not.toThrow(); }
  });
});
