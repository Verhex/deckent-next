import { expect, it } from 'vitest';
import { deckentMetricsSchema, deriveDeckentMetrics, type CurrentDeckentMetrics } from '#domain/index.js';
const digest = 'a'.repeat(64);
const input: Omit<CurrentDeckentMetrics, 'schemaVersion' | 'durationMs' | 'cost'> = {
  identity: { scopeId: 'company-scope', runId: 'run', taskId: 'task', attemptId: 'attempt' },
  workClass: 'business-class', policyRevision: '["core-r1","overlay-r1"]', profileVersion: 2, skillSetDigest: null,
  model: { channelId: 'registry-channel', modelId: 'exact-registry-model' },
  outcome: { kind: 'task', status: 'accepted', decision: 'system' }, attemptSequence: 1,
  effort: null, actualModel: null, evidenceKinds: ['operation-record'], acceptanceScore: null,
  evidenceReferences: [{ id: 'settlement', digest }, { id: 'approval', digest: 'b'.repeat(64) }],
};
it('keeps missing measurements null and carries exact registry identities without inventing a price', () => {
  const row = deriveDeckentMetrics(input);
  expect(row.durationMs).toBeNull(); expect(row.cost).toBeNull(); expect(row.skillSetDigest).toBeNull();
  expect(row.model).toEqual(input.model); expect(row.policyRevision).toBe(input.policyRevision);
});
it.each([{ startedAtMs: null, endedAtMs: 10 }, { startedAtMs: 10 }, { endedAtMs: 20 },
  { startedAtMs: 10, endedAtMs: 10 }, { startedAtMs: 20, endedAtMs: 10 }])('missing or invalid clock pair stays unmeasured: %j', measurements => {
  expect(deriveDeckentMetrics(input, measurements).durationMs).toBeNull();
});
it('records only measured duration and exact decimal monetary value with its pinned tariff', () => {
  const cost = { basis: 'measured-tariff' as const, amountUsdNanos: '9007199254740993000', tariffDigest: digest };
  expect(deriveDeckentMetrics(input, { startedAtMs: 10, endedAtMs: 25, cost })).toMatchObject({ durationMs: 15, cost });
  expect(deriveDeckentMetrics(input, { cost: { ...cost, amountUsdNanos: '0' } }).cost?.amountUsdNanos).toBe('0');
});
it('rejects guessed money, unsafe timestamps and extra measurement inputs', () => {
  for (const measurements of [{ cost: { basis: 'estimated', amountUsdNanos: '1', tariffDigest: digest } },
    { cost: { basis: 'measured-tariff', amountUsdNanos: '01', tariffDigest: digest } },
    { cost: { basis: 'measured-tariff', amountUsdNanos: '-1', tariffDigest: digest } },
    { startedAtMs: Number.MAX_SAFE_INTEGER + 1 }, { startedAtMs: -1 }, { endedAtMs: Infinity }, { guessedMs: 12 }]) {
    expect(() => deriveDeckentMetrics(input, measurements as never)).toThrow();
  }
});
it('sorts exact evidence references deterministically without mutating inputs or promoting metadata to acceptance', () => {
  const before = JSON.stringify(input), row = deriveDeckentMetrics(input);
  expect(row.evidenceReferences.map(reference => reference.id)).toEqual(['approval', 'settlement']);
  expect(deriveDeckentMetrics({ ...input, evidenceReferences: [...input.evidenceReferences].reverse() })).toEqual(row);
  expect(JSON.stringify(input)).toBe(before); expect(Object.isFrozen(row)).toBe(true);
  // Schema describes an observed result; the existing evaluation application remains the evidence gate.
  expect(deriveDeckentMetrics({ ...input, outcome: { kind: 'task', status: 'failed', decision: 'system' }, evidenceReferences: [] }).outcome).toMatchObject({ status: 'failed' });
});
it('has only the exact named-consumer key set and rejects silent field additions', () => {
  const row = deriveDeckentMetrics(input);
  expect(Object.keys(row).sort()).toEqual(['schemaVersion', 'identity', 'workClass', 'policyRevision', 'profileVersion', 'skillSetDigest',
    'model', 'outcome', 'durationMs', 'cost', 'attemptSequence', 'evidenceReferences', 'effort', 'actualModel', 'evidenceKinds', 'acceptanceScore'].sort());
  expect(deckentMetricsSchema.safeParse({ ...row, confidence: 0.99 }).success).toBe(false);
  expect(deckentMetricsSchema.safeParse({ ...row, model: { ...row.model, alias: 'shortcut' } }).success).toBe(false);
});
it('distinguishes Run incomplete from Task outcomes and refuses debt acceptance vocabulary', () => {
  for (const status of ['accepted', 'failed', 'awaiting-decision'] as const) expect(deriveDeckentMetrics({ ...input, outcome: { kind: 'task', status, decision: 'human' } }).outcome).toMatchObject({ status });
  expect(deriveDeckentMetrics({ ...input, outcome: { kind: 'run', status: 'incomplete' } }).outcome).toEqual({ kind: 'run', status: 'incomplete' });
  for (const outcome of [{ kind: 'task', status: 'incomplete', decision: 'system' }, { kind: 'run', status: 'accepted' }, { kind: 'task', status: 'done-with-debt', decision: 'system' },
    { kind: 'task', status: 'accepted' }, { kind: 'task', status: 'accepted', decision: 'model' }, { kind: 'quota-park' }]) {
    expect(deckentMetricsSchema.safeParse({ ...deriveDeckentMetrics(input), outcome }).success).toBe(false);
  }
});
it('refuses ambiguous attribution, duplicate evidence and class/revision half-bindings', () => {
  const row = deriveDeckentMetrics(input);
  for (const changed of [{ ...row, identity: { ...row.identity, scopeId: '' } }, { ...row, identity: { runId: 'run', taskId: 'task' } },
    { ...row, evidenceReferences: [row.evidenceReferences[0], row.evidenceReferences[0]] },
    { ...row, evidenceReferences: [{ id: 'proof', digest: 'unsealed' }] }, { ...row, policyRevision: null },
    { ...row, workClass: null }, { ...row, attemptSequence: 0 }, { ...row, durationMs: 0 },
    // v2: evidence kinds are a sorted set from the closed vocabulary; the score is a probability-like bound, not free text.
    { ...row, evidenceKinds: ['operation-record', 'exit-code'] }, { ...row, evidenceKinds: ['exit-code', 'exit-code'] }, { ...row, evidenceKinds: ['model-said-so'] },
    { ...row, acceptanceScore: 1.5 }, { ...row, actualModel: { reported: 'x', verdict: 'verified', evidence: 'worker-claimed', capability: 'session-events' } }]) expect(deckentMetricsSchema.safeParse(changed).success).toBe(false);
  expect(deriveDeckentMetrics({ ...input, workClass: null, policyRevision: null, model: null, profileVersion: null }).model).toBeNull();
});
it('sorts and de-duplicates evidence kinds and carries a human decision duration only without a clock interval', () => {
  expect(deriveDeckentMetrics({ ...input, evidenceKinds: ['unknown', 'human-decision', 'unknown'] }).evidenceKinds).toEqual(['human-decision', 'unknown']);
  expect(deriveDeckentMetrics(input, { carriedDurationMs: 40 }).durationMs).toBe(40);
  expect(deriveDeckentMetrics(input, { startedAtMs: 10, endedAtMs: 25, carriedDurationMs: 40 }).durationMs).toBe(15);
});
