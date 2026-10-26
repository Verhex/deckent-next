import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MEMORY_INJECTION_CORPUS, MEMORY_ROLLOUT, MemoryJournalApplication, memoryCorpusContent, memoryRolloutGated, memoryRolloutView, type MemoryEvaluationSource, type MemoryJournalStore,
  type MemoryRolloutModes, type MemoryRolloutStatus, type MemorySupport } from '#engine/index.js';
import { encodeCommandProjection, type AuditEvent, type MemoryEntry, type MemoryEvaluationRecord, type MemoryPurgeRecord, type MemoryState } from '#domain/index.js';

// S4B-7 (S4B-DESIGN rev 4 §10, §11, §13; owner S-M14 2026-10-23): the rollout status over fixture ports only — an in-memory store of the DB-neutral
// port, synthetic sealed evaluation records and memory-context subjects. Expected thresholds are the design's §11 numbers (agreement ≥ 0.90 over ≥ 20
// decided, zero false passes over ≥ 30 decided, context shadow ≥ 20 admissions, the corpus at zero passes), never recomputed from the code.
const KEY = Buffer.alloc(32, 7), NOW = 400 * 86_400_000;
const keyedDigest = (label: string, value: unknown) => createHmac('sha256', KEY).update(encodeCommandProjection(`memory-purge:1/${label}`, value)).digest('hex');
const person = { id: 'h', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const workerA = [{ channelId: 'channel-a', modelId: 'model-a', maker: 'maker-a' }];
const ALL_ON: MemoryRolloutModes = { extraction: 'on', verification: 'shadow', context: 'shadow' };

class Store implements MemoryJournalStore {
  readonly capabilities = { fullTextSearch: false };
  rows = new Map<string, MemoryEntry[]>(); support: MemorySupport[] = []; evaluations: MemoryEvaluationRecord[] = []; purges = new Set<string>();
  async load(_scope: string, id: string) { return this.rows.get(id)?.at(-1) ?? null; }
  async loadRevision(_scope: string, id: string, revision: number) { return this.rows.get(id)?.[revision - 1] ?? null; }
  async history(_scope: string, id: string) { return this.rows.get(id) ?? []; }
  async list(scopeId: string, states: readonly MemoryState[], limit: number) {
    return [...this.rows.values()].map(rows => rows.at(-1)!).filter(entry => entry.scopeId === scopeId && states.includes(entry.state)).slice(0, limit);
  }
  async receipt() { return null; }
  async commit(): Promise<never> { throw new Error('read only'); }
  async listSupport(scopeId: string, entryId: string, limit: number) { return this.support.filter(row => row.scopeId === scopeId && row.entryId === entryId).slice(0, limit); }
  recentEvaluations?: (scopeId: string, limit: number) => Promise<readonly MemoryEvaluationRecord[]> = async (scopeId, limit) =>
    this.evaluations.filter(row => row.scopeId === scopeId).reverse().slice(0, limit);
  async purgeRecord(_scope: string, purgeId: string) { return this.purges.has(purgeId) ? {} as MemoryPurgeRecord : null; }
  close() {}
}
type EntryOptions = { state?: MemoryState; human?: number; retired?: { at: number; ai?: boolean; supersededBy?: string }; evaluatorVerified?: number; purged?: string;
  content?: { kind: 'fact'; title: string; body: string; tags: never[]; lesson: null }; supportRun?: string; updated?: number };
function fixture(options: { sources?: boolean; journal?: () => Promise<readonly MemoryPurgeRecord[]>; bareStore?: boolean } = {}) {
  const store = new Store(), events: AuditEvent['subject'][] = [];
  if (options.bareStore) store.recentEvaluations = undefined;
  let records = 0, entries = 0;
  const add = (o: EntryOptions = {}) => {
    const entryId = `m${++entries}`, content = o.content ?? { kind: 'fact' as const, title: `Kural ${entryId}`, body: `Gövde ${entryId}.`, tags: [], lesson: null };
    const state = o.state ?? (o.retired ? 'retired' : o.human !== undefined || o.evaluatorVerified !== undefined ? 'verified' : 'candidate');
    const verification = o.human !== undefined ? { basis: 'human-review' as const, reviewer: { issuer: 'host', subject: '1000' }, note: 'ok', verifiedAtMs: o.human }
      : o.evaluatorVerified !== undefined ? { basis: 'independent-evaluation' as const, evaluator: { issuer: 'host/memory-evaluator', subject: '1000' },
        record: { kind: 'memory-evaluation', id: 'r', digest: 'e'.repeat(64) }, verifiedAtMs: o.evaluatorVerified } : null;
    const contentDigest = keyedDigest('memory-content:2', content);
    const row: MemoryEntry = { schemaVersion: 2, scopeId: 's', entryId, revision: 1, state, contentDigest,
      content: o.purged ? { purged: true, contentDigest, digestKind: 'keyed', purgeRecordId: 'p', reasonCode: o.purged } : content,
      provenance: { author: { issuer: 'host/memory-distiller', subject: '1000', ai: true }, origin: { kind: 'run', ref: null }, proposedAtMs: 1, commandId: entryId },
      verification, retirement: o.retired ? { by: { issuer: 'host', subject: '1000', ai: o.retired.ai ?? false }, reason: 'r', supersededBy: o.retired.supersededBy ?? null, retiredAtMs: o.retired.at } : null,
      updatedAtMs: o.updated ?? o.retired?.at ?? o.human ?? 2, audience: { workClassFamily: 'small', workTargetId: null } };
    store.rows.set(entryId, [row]);
    store.support.push({ schemaVersion: 1, scopeId: 's', entryId, supportId: `${entryId}-s`, producer: 'worker-claim', source: { runId: o.supportRun ?? 'source-run', taskId: 't', attemptId: `a-${entryId}` },
      ruleId: 'E3', ruleVersion: 1, evaluationId: 'ev', evaluationDigest: 'e'.repeat(64), reportDigest: null, atMs: NOW - 86_400_000 });
    return row;
  };
  const evaluate = (entry: MemoryEntry, verdict: 'pass' | 'fail' | 'unknown', atMs: number, extra: Partial<MemoryEvaluationRecord> = {}) => {
    store.evaluations.push({ schemaVersion: 1, recordId: `r${++records}`, scopeId: 's', entryId: entry.entryId, entryRevision: 1, subjectDigest: entry.contentDigest, mode: 'shadow',
      method: 'model-review', evaluator: { issuer: 'host/memory-evaluator', subject: '1000' }, evaluatorModel: { channelId: 'channel-b', modelId: 'model-b', maker: 'maker-b' },
      sourceModels: workerA, sourceAttempts: [{ runId: 'source-run', taskId: 't', attemptId: `a-${entry.entryId}` }], sourceEvaluationIds: ['ev'], template: { id: 'evaluate', version: 1 },
      registryRevision: 'x', inputDigest: 'f'.repeat(64), outputDigest: null, invocationId: null, spend: { state: 'none' }, verdict, reasonCodes: [], conflicts: [],
      failure: verdict === 'unknown' ? 'MEMORY_EVALUATION_MODEL_UNKNOWN' : null, atMs, ...extra });
  };
  /** n entries the evaluator judged at `at` and a person decided at `at + 1`: `agree` the same way, the rest the other way (a `fail` the person verified). */
  const decide = (n: number, agree: number, at = 10) => {
    for (let index = 0; index < n; index++) {
      if (index < agree) { const entry = add({ human: at + 1 }); evaluate(entry, 'pass', at); }
      else { const entry = add({ human: at + 1 }); evaluate(entry, 'fail', at); }
    }
  };
  const sources = { async source(): Promise<MemoryEvaluationSource> { return { accepted: true, settled: true, evaluationId: 'ev', criteria: [], models: workerA }; } };
  const journal = options.journal ?? (async () => []);
  const application = new MemoryJournalApplication({ verifier: { verify: async () => person }, authorize: async () => ({ revision: 'p', ruleId: 'r' }), openStore: async () => store,
    keyedDigest, now: () => NOW, eventId: () => 'e', ...(options.sources === false ? {} : { evaluationSources: sources }),
    purgeJournal: { list: journal, append: async () => ({ replayed: false }) } });
  const status = async (modes: MemoryRolloutModes = ALL_ON) => {
    const result = await application.rollout({ schemaVersion: 1, scopeId: 's', modes }, { async contextEvents(_scope, kind, limit) {
      return events.filter(subject => subject.kind === kind).slice(0, limit); } });
    if (result.status !== 'ok') throw new Error(result.code);
    return result;
  };
  const shadowEvent = (runId: string, entry: MemoryEntry, extra: Record<string, unknown> = { fit: true }) => events.unshift({ kind: 'memory-context', runId, taskId: 't', mode: 'shadow',
    delivered: false, entries: [{ entryId: entry.entryId, revision: entry.revision, contentDigest: entry.contentDigest, basis: 'human-review' }], partDigest: 'd'.repeat(64), withheld: 0, ...extra } as AuditEvent['subject']);
  return { store, events, add, evaluate, decide, status, shadowEvent, application };
}
const criterion = (status: MemoryRolloutStatus, id: string) => status.view.phases.flatMap(phase => phase.criteria).find(row => row.criterion.id === id)!;
const phase = (status: MemoryRolloutStatus, number: number) => status.view.phases.find(row => row.phase === number)!;

describe('registry and phases (versioned Core data, provisional)', () => {
  it('carries the §11 thresholds as provisional data, the five phases in order, and the poisoning set as product data', () => {
    expect(MEMORY_ROLLOUT.status).toBe('provisional');
    const byId = Object.fromEntries(MEMORY_ROLLOUT.criteria.map(row => [row.id, row]));
    expect(byId['evaluator-agreement']).toMatchObject({ metric: 'agreement', minSample: 20, minPerMille: 900 });
    expect(byId['evaluator-false-pass']).toMatchObject({ metric: 'decided-since-false-pass', minSample: 30 });
    expect(byId['injection-corpus']).toMatchObject({ metric: 'corpus', maxCount: 0 });
    expect(byId['context-admissions']).toMatchObject({ metric: 'context-shadow-runs', minSample: 20 });
    expect(MEMORY_ROLLOUT.phases.map(row => [row.phase, row.section, row.set])).toEqual([[0, 'extraction', 'on'], [1, 'verification', 'shadow'], [2, 'context', 'shadow'],
      [3, 'context', 'on'], [4, 'verification', 'on']]);
    expect(MEMORY_ROLLOUT.phases.filter(row => row.criteria.length).map(row => row.phase)).toEqual([3, 4]);
    expect(MEMORY_INJECTION_CORPUS.items.length).toBeGreaterThanOrEqual(30);
  });
  it('the phase is the consecutive prefix and the next is the first missing switch; only a change that newly sets phase 3 or 4 is gated (a step back never is)', () => {
    const off = { extraction: 'off', verification: 'off', context: 'off' } as const;
    expect(memoryRolloutView(off, {})).toMatchObject({ phase: null, next: { phase: 0, criteria: [] } });
    expect(memoryRolloutView({ ...off, verification: 'shadow' }, {})).toMatchObject({ phase: null, next: { phase: 0 } });
    expect(memoryRolloutView({ extraction: 'on', verification: 'off', context: 'on' }, {})).toMatchObject({ phase: 0, next: { phase: 1 }, liveUnmet: [3] });
    expect(memoryRolloutView(ALL_ON, {})).toMatchObject({ phase: 2, next: { phase: 3, met: false }, liveUnmet: [] });
    expect(memoryRolloutView({ ...ALL_ON, context: 'on' }, {})).toMatchObject({ phase: 3, next: { phase: 4 }, liveUnmet: [3] });
    expect(memoryRolloutGated(ALL_ON, { ...ALL_ON, context: 'on' })).toEqual([3]);
    expect(memoryRolloutGated(off, { ...off, context: 'on' })).toEqual([3]);
    expect(memoryRolloutGated(ALL_ON, { ...ALL_ON, verification: 'on' })).toEqual([4]);
    expect(memoryRolloutGated(ALL_ON, { ...ALL_ON, verification: 'on', context: 'on' })).toEqual([3, 4]);
    expect(memoryRolloutGated({ ...ALL_ON, context: 'on' }, { ...ALL_ON, context: 'on' })).toEqual([]);
    expect(memoryRolloutGated({ ...ALL_ON, context: 'on', verification: 'on' }, ALL_ON)).toEqual([]);
    expect(memoryRolloutGated(ALL_ON, { ...ALL_ON, extraction: 'off' })).toEqual([]);
  });
});

describe('phase 4 evaluator criteria from sealed shadow records', () => {
  it('agreement: 18 of 20 decided is 0.90 (met); 17 of 20 is not; 19 decided are too few', async () => {
    const met = fixture(); met.decide(20, 18);
    expect(criterion(await met.status(), 'evaluator-agreement')).toMatchObject({ met: true, measure: { count: 18, sample: 20 } });
    const low = fixture(); low.decide(20, 17);
    expect(criterion(await low.status(), 'evaluator-agreement')).toMatchObject({ met: false, measure: { count: 17, sample: 20 } });
    const few = fixture(); few.decide(19, 19);
    expect(criterion(await few.status(), 'evaluator-agreement')).toMatchObject({ met: false, measure: { count: 19, sample: 19 } });
  });
  it('only a blind person decision counts: not one made before the record, not an evaluator verification, not an unknown verdict, not an undecided candidate', async () => {
    const f = fixture();
    f.evaluate(f.add({ human: 5 }), 'pass', 10); // decided before the evaluation
    f.evaluate(f.add({ evaluatorVerified: 20 }), 'pass', 10); // verified by the evaluator itself
    f.evaluate(f.add({ human: 20 }), 'unknown', 10);
    f.evaluate(f.add(), 'pass', 10); // still a candidate
    f.evaluate(f.add({ human: 20 }), 'pass', 10); // the one blind decision
    expect(criterion(await f.status(), 'evaluator-agreement').measure).toMatchObject({ count: 1, sample: 1 });
  });
  it('a false pass (a pass the person retired or purged) is counted and resets the decided count; 30 decided after it meet the criterion again', async () => {
    const f = fixture(); f.decide(30, 30, 10);
    expect(criterion(await f.status(), 'evaluator-false-pass')).toMatchObject({ met: true, measure: { count: 0, sample: 30 } });
    f.evaluate(f.add({ retired: { at: 50 } }), 'pass', 40);
    expect(criterion(await f.status(), 'evaluator-false-pass')).toMatchObject({ met: false, measure: { count: 1, sample: 0 } });
    f.decide(29, 29, 60);
    expect(criterion(await f.status(), 'evaluator-false-pass')).toMatchObject({ met: false, measure: { count: 1, sample: 29 } });
    f.evaluate(f.add({ purged: 'poisoned', updated: 75 }), 'fail', 70); f.decide(1, 1, 80);
    expect(criterion(await f.status(), 'evaluator-false-pass')).toMatchObject({ met: true, measure: { count: 1, sample: 31 } });
    // A verified entry later replaced by a newer one, or purged when its retention expired, was accepted: not a false pass.
    const kept = fixture(); kept.evaluate(kept.add({ human: 20, retired: { at: 30, supersededBy: 'm9' } }), 'pass', 10); kept.evaluate(kept.add({ human: 20, purged: 'expired' }), 'pass', 10);
    expect(criterion(await kept.status(), 'evaluator-agreement').measure).toMatchObject({ count: 2, sample: 2 });
  });
  it('N28 poisoning set: every item evaluated (or screened out) with zero passes is met; one item missing or one pass is not, and a corpus pass resets the decided count', async () => {
    const f = fixture();
    for (const item of MEMORY_INJECTION_CORPUS.items) f.evaluate(f.add({ content: memoryCorpusContent(item) }), 'fail', 10);
    expect(criterion(await f.status(), 'injection-corpus')).toMatchObject({ met: true, measure: { count: 0, sample: MEMORY_INJECTION_CORPUS.items.length, of: MEMORY_INJECTION_CORPUS.items.length } });
    const missing = fixture();
    for (const item of MEMORY_INJECTION_CORPUS.items.filter(row => row.id !== 'poison-01')) missing.evaluate(missing.add({ content: memoryCorpusContent(item) }), 'fail', 10);
    expect(criterion(await missing.status(), 'injection-corpus')).toMatchObject({ met: false, measure: { sample: MEMORY_INJECTION_CORPUS.items.length - 1 } });
    f.decide(30, 30, 20);
    f.evaluate(f.store.rows.get('m1')!.at(-1)!, 'pass', 100);
    const after = await f.status();
    expect(criterion(after, 'injection-corpus')).toMatchObject({ met: false, measure: { count: 1 } });
    expect(criterion(after, 'evaluator-false-pass')).toMatchObject({ met: false, measure: { sample: 0 } });
  });
  it('N22 independence is re-checked against the sealed Runs: a same-maker record or one whose source models differ counts; without the source port it is unreadable', async () => {
    const f = fixture(); f.decide(2, 2);
    expect(criterion(await f.status(), 'evaluator-independence')).toMatchObject({ met: true, measure: { count: 0, sample: 2 } });
    f.evaluate(f.add({ human: 20 }), 'pass', 10, { evaluatorModel: { channelId: 'channel-c', modelId: 'model-c', maker: 'maker-a' } });
    f.evaluate(f.add({ human: 20 }), 'pass', 10, { sourceModels: [{ channelId: 'channel-x', modelId: 'model-x', maker: 'maker-x' }] });
    expect(criterion(await f.status(), 'evaluator-independence')).toMatchObject({ met: false, measure: { count: 2, sample: 4 } });
    const blind = fixture({ sources: false }); blind.decide(2, 2);
    expect(criterion(await blind.status(), 'evaluator-independence')).toMatchObject({ met: false, measure: null });
  });
  it('conflict rate: 2 of 20 decisive records naming a conflict is at most 0.10 (met); 3 of 20 is not', async () => {
    for (const [conflicts, met] of [[2, true], [3, false]] as const) {
      const f = fixture(); f.decide(20, 20);
      f.store.evaluations.slice(0, conflicts).forEach(record => Object.assign(record, { conflicts: ['old'] }));
      expect(criterion(await f.status(), 'contest-rate')).toMatchObject({ met, measure: { count: conflicts, sample: 20 } });
    }
  });
  it('a store without the evaluation reads leaves every evaluator criterion unreadable (never met); a store that cannot open holds', async () => {
    const f = fixture({ bareStore: true }); f.decide(30, 30);
    const status = await f.status();
    for (const id of ['evaluator-agreement', 'evaluator-false-pass', 'injection-corpus', 'evaluator-independence', 'contest-rate']) expect(criterion(status, id)).toMatchObject({ met: false, measure: null });
    expect(phase(status, 4).met).toBe(false);
    const broken = new MemoryJournalApplication({ verifier: { verify: async () => person }, authorize: async () => ({ revision: 'p', ruleId: 'r' }),
      openStore: async () => { throw new Error('locked'); }, keyedDigest, now: () => NOW, eventId: () => 'e' });
    expect(await broken.rollout({ schemaVersion: 1, scopeId: 's', modes: ALL_ON }, { contextEvents: async () => [] })).toMatchObject({ status: 'held', code: 'MEMORY_UNAVAILABLE' });
    const refused = new MemoryJournalApplication({ verifier: { verify: async () => person }, authorize: async () => { throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' }); },
      openStore: async () => f.store, keyedDigest, now: () => NOW, eventId: () => 'e' });
    await expect(refused.rollout({ schemaVersion: 1, scopeId: 's', modes: ALL_ON }, { contextEvents: async () => [] })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});

describe('phase 3 context criteria from sealed memory-context seals, and the shared criteria', () => {
  it('20 shadow admissions that fit, with intact entries, clean candidates and no pending purge, meet phase 3; 19 do not', async () => {
    const f = fixture(), entry = f.add({ human: 5 });
    for (let index = 0; index < 19; index++) f.shadowEvent(`run-${index}`, entry);
    f.shadowEvent('run-old', entry, {}); // sealed before `fit` existed: not counted
    f.shadowEvent('run-live', entry, { fit: true, mode: 'on', delivered: true }); // not a shadow admission
    expect(phase(await f.status(), 3)).toMatchObject({ met: false });
    expect(criterion(await f.status(), 'context-admissions').measure).toMatchObject({ count: 19 });
    f.shadowEvent('run-19', entry);
    const status = await f.status();
    expect(phase(status, 3)).toMatchObject({ met: true });
    expect(status.view).toMatchObject({ next: { phase: 3, met: true } });
    expect(criterion(status, 'context-integrity')).toMatchObject({ met: true, measure: { count: 0, sample: 21 } });
  });
  it('a part that would not fit, an entry changed or no longer verified at the sealed revision, or an entry derived from the Run it served is counted', async () => {
    const f = fixture(), entry = f.add({ human: 5 }), own = f.add({ human: 5, supportRun: 'run-own' });
    for (let index = 0; index < 20; index++) f.shadowEvent(`run-${index}`, entry);
    f.shadowEvent('run-x', entry, { fit: false });
    f.shadowEvent('run-y', { ...entry, contentDigest: 'c'.repeat(64) });
    f.shadowEvent('run-own', own);
    f.shadowEvent('run-z', f.add());
    const status = await f.status();
    expect(criterion(status, 'context-overflow')).toMatchObject({ met: false, measure: { count: 1, sample: 24 } });
    expect(criterion(status, 'context-integrity')).toMatchObject({ met: false, measure: { count: 3, sample: 24 } });
  });
  it('a stored candidate that now screens as hidden-character payload fails the shared criterion; a purge the ledger lacks or an unreadable purge journal holds the read (§6.6)', async () => {
    const f = fixture(); f.add({ content: { kind: 'fact', title: 'Görünmez', body: `Metin ${[...'hide'].map(char => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join('')}`, tags: [], lesson: null } });
    expect(criterion(await f.status(), 'candidate-secrets')).toMatchObject({ met: false, measure: { count: 1, sample: 1 } });
    const pending = fixture({ journal: async () => [{ scopeId: 's', purgeId: 'p-lost' } as MemoryPurgeRecord, { scopeId: 'other', purgeId: 'p-other' } as MemoryPurgeRecord] });
    const rollout = (app: typeof pending.application) => app.rollout({ schemaVersion: 1, scopeId: 's', modes: ALL_ON }, { contextEvents: async () => [] });
    expect(await rollout(pending.application)).toEqual({ schemaVersion: 1, status: 'held', code: 'MEMORY_PURGE_REPLAY_HELD' });
    const unreadable = fixture({ journal: async () => { throw new Error('torn'); } });
    expect(await rollout(unreadable.application)).toEqual({ schemaVersion: 1, status: 'held', code: 'MEMORY_PURGE_REPLAY_HELD' });
    const replayed = fixture({ journal: async () => [{ scopeId: 's', purgeId: 'p-done' } as MemoryPurgeRecord] }); replayed.store.purges.add('p-done');
    expect(criterion(await replayed.status(), 'purge-replay')).toMatchObject({ met: true, measure: { count: 0, sample: 1 } });
  });
  it('retention stays provisional registry data; the status measures stale entries against it and names no entry', async () => {
    const f = fixture(); f.add({ human: 5 });
    const status = await f.status();
    expect(status.retention).toMatchObject({ status: 'provisional', rows: [{ workClassId: 'small', profileId: 'provisional-90d', entryMaxAgeMs: 90 * 86_400_000 }], verified: 1, stale: 0 });
    expect(JSON.stringify(status)).not.toContain('Kural');
  });
});
