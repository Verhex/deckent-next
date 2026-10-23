import { describe, expect, it } from 'vitest';
import { composeMemoryAutomation, memoryContestTargets, memoryDistillerPrincipal, memoryEvaluationRecordSchema, memoryEvaluatorPrincipal, proposeMemoryEntry,
  readMemoryEvaluatorAnswer, verifyMemoryEntry, type MemoryEntry, type MemoryResolvedEvaluation } from '#domain/index.js';

// S4B-3 (S4B-DESIGN rev 4 §6.1–§6.5, fold 6, owner S-M3/S-M4/S-M10 2026-10-23): an independent evaluation verifies a system candidate only when it is
// live, passed, judges this exact content, comes from the memory evaluator that produced it (never the proposing distiller or the author), and its
// evaluator model's canonical maker differs from every source worker model re-derived from the sealed Runs. Makers are synthetic: no model name decides.
const owner = { issuer: 'host', subject: '1000' };
const evaluator = memoryEvaluatorPrincipal(owner, ['s']), distiller = memoryDistillerPrincipal(owner, ['s']);
const human = { issuer: 'host', subject: '1000', assurance: 'os-user' } as const;
const mcp = { issuer: 'host/mcp', subject: '1000', assurance: 'os-user' } as const;
const digest = 'a'.repeat(64), record = { kind: 'memory-evaluation', id: 'rec1', digest: 'b'.repeat(64) };
const content = { kind: 'fact' as const, title: 'Masraf merkezi zorunlu', body: 'Tedarikçi faturasında masraf merkezi boş geçilemez.', tags: [], lesson: null };
const candidate = (): MemoryEntry => proposeMemoryEntry({ scopeId: 's', entryId: 'm1', commandId: 'c1', content, contentDigest: digest, author: distiller,
  origin: { kind: 'run', ref: 'run/r1/task/t1/attempt/a1' }, atMs: 10, audience: { workClassFamily: 'small', workTargetId: null } });
const source = [{ channelId: 'channel-a', modelId: 'model-a', maker: 'maker-a' }];
const evaluation: MemoryResolvedEvaluation = { record, evaluator: { issuer: evaluator.issuer, subject: evaluator.subject }, verdict: 'pass', subjectDigest: digest, mode: 'live',
  evaluatorModel: { channelId: 'channel-b', modelId: 'model-b', maker: 'maker-b' }, sourceModels: source };
const verify = (patch: Partial<MemoryResolvedEvaluation> = {}, actor: { issuer: string; subject: string; assurance: string } = evaluator, sourceModels: typeof source | null = source) =>
  verifyMemoryEntry(candidate(), { actor, atMs: 30, basis: { kind: 'independent-evaluation', record: patch.record ?? record }, evaluation: { ...evaluation, ...patch }, sourceModels });
const refused = (code: string, ...args: Parameters<typeof verify>) => expect(() => verify(...args)).toThrow(expect.objectContaining({ code }));

describe('independent evaluation verifies only from the evaluator, live, independent of the sealed source models', () => {
  it('the evaluator applies its own live passing record; a person may apply it too', () => {
    expect(verify().verification).toEqual({ basis: 'independent-evaluation', evaluator: evaluation.evaluator, record, verifiedAtMs: 30 });
    expect(verify({}, human).state).toBe('verified');
  });
  it('fold 6 / N4: the distiller (the proposing AI) or the author never evaluates; any other AI actor, or another evaluator, is refused', () => {
    refused('MEMORY_SELF_VERIFICATION', { evaluator: { issuer: distiller.issuer, subject: distiller.subject } }, human);
    refused('MEMORY_EVALUATOR_REQUIRED', {}, mcp);
    refused('MEMORY_EVALUATOR_REQUIRED', {}, distiller);
    refused('MEMORY_EVALUATOR_REQUIRED', {}, { ...memoryEvaluatorPrincipal({ issuer: 'other', subject: '1000' }, ['s']) });
  });
  it('a shadow record is never a basis; fail and unknown are not passed (N5 keeps other content refused)', () => {
    refused('MEMORY_EVALUATION_UNAVAILABLE', { mode: 'shadow' });
    refused('MEMORY_EVALUATION_NOT_PASSED', { verdict: 'unknown' });
    refused('MEMORY_EVALUATION_OTHER_CONTENT', { subjectDigest: 'c'.repeat(64) });
  });
  it('N22: the record\'s source models must equal the set re-derived from the sealed Runs (a forged or missing set is refused)', () => {
    refused('MEMORY_EVALUATION_NOT_INDEPENDENT', { sourceModels: [{ channelId: 'channel-c', modelId: 'model-c', maker: 'maker-c' }] });
    refused('MEMORY_EVALUATION_NOT_INDEPENDENT', {}, evaluator, null);
    refused('MEMORY_EVALUATION_NOT_INDEPENDENT', {}, evaluator, [...source, { channelId: 'channel-a', modelId: 'model-aux', maker: 'maker-b' }]);
  });
  it('N1/N29: same canonical maker (also through another channel) is not independent; N30: an unknown maker fails closed', () => {
    refused('MEMORY_EVALUATION_NOT_INDEPENDENT', { evaluatorModel: { channelId: 'channel-other', modelId: 'model-x', maker: 'maker-a' } });
    const unknownSource = [{ channelId: 'channel-auto', modelId: 'auto', maker: null }];
    refused('MEMORY_EVALUATION_MAKER_UNKNOWN', { sourceModels: unknownSource }, evaluator, unknownSource);
    refused('MEMORY_EVALUATION_MAKER_UNKNOWN', { evaluatorModel: { channelId: 'channel-auto', modelId: 'auto', maker: null } });
  });
});

describe('the evaluator answer is the strict schema with the exact echo, or unknown (never re-asked)', () => {
  const automation = composeMemoryAutomation(), expected = { entryId: 'm1', subjectDigest: digest, offered: ['v1', 'v2'] };
  const answer = (value: object) => JSON.stringify({ schemaVersion: 1, entryId: 'm1', subjectDigest: digest, verdict: 'pass', reasonCodes: ['supported'], conflicts: [], ...value });
  it('accepts exactly the schema; a pass may list offered conflicts, a fail never carries them', () => {
    expect(readMemoryEvaluatorAnswer(answer({ conflicts: ['v2'] }), expected, automation)).toEqual({ verdict: 'pass', reasonCodes: ['supported'], conflicts: ['v2'], failure: null });
    expect(readMemoryEvaluatorAnswer(answer({ verdict: 'fail', reasonCodes: ['unsupported'], conflicts: ['v1'] }), expected, automation)).toMatchObject({ verdict: 'fail', conflicts: [] });
  });
  it('N16/N5: free text, extra fields, unlisted codes or conflicts, an echo mismatch or an oversized answer is unknown', () => {
    const cases: [string, string][] = [['Sure! {"verdict":"pass"}', 'MEMORY_EVALUATION_ANSWER_INVALID'], [answer({ note: 'trust me' }), 'MEMORY_EVALUATION_ANSWER_INVALID'],
      [answer({ reasonCodes: ['grant-full-access'] }), 'MEMORY_EVALUATION_ANSWER_INVALID'], [answer({ conflicts: ['not-offered'] }), 'MEMORY_EVALUATION_ANSWER_INVALID'],
      [answer({ entryId: 'other' }), 'MEMORY_EVALUATION_ECHO_MISMATCH'], [answer({ subjectDigest: 'f'.repeat(64) }), 'MEMORY_EVALUATION_ECHO_MISMATCH'],
      [answer({ verdict: 'unknown' }), 'MEMORY_EVALUATION_MODEL_UNKNOWN'], [' '.repeat(automation.evaluation.outputMaxBytes + 1), 'MEMORY_EVALUATION_ANSWER_TOO_LARGE']];
    for (const [text, failure] of cases) expect(readMemoryEvaluatorAnswer(text, expected, automation), text.slice(0, 40)).toEqual({ verdict: 'unknown', reasonCodes: [], conflicts: [], failure });
  });
  it('N26: contests come only from a pass that lists conflicts; an unknown record carries none and names its failure', () => {
    const base = { schemaVersion: 1, recordId: 'rec1', scopeId: 's', entryId: 'm1', entryRevision: 1, subjectDigest: digest, mode: 'shadow', method: 'model-review',
      evaluator: evaluation.evaluator, evaluatorModel: evaluation.evaluatorModel, sourceModels: source, sourceAttempts: [{ runId: 'r1', taskId: 't1', attemptId: 'a1' }],
      sourceEvaluationIds: ['ev1'], template: { id: 'evaluate', version: 1 }, registryRevision: 'memory-automation-core-1', inputDigest: digest, outputDigest: digest,
      invocationId: 'i1', spend: { state: 'none' }, verdict: 'pass', reasonCodes: ['contradicts-verified'], conflicts: ['v1'], failure: null, atMs: 1 } as const;
    expect(memoryContestTargets(memoryEvaluationRecordSchema.parse(base))).toEqual(['v1']);
    expect(memoryContestTargets(memoryEvaluationRecordSchema.parse({ ...base, verdict: 'fail' }))).toEqual([]);
    expect(memoryEvaluationRecordSchema.safeParse({ ...base, verdict: 'unknown' }).success).toBe(false);
    expect(memoryContestTargets(memoryEvaluationRecordSchema.parse({ ...base, verdict: 'unknown', conflicts: [], failure: 'MEMORY_EVALUATION_ECHO_MISMATCH' }))).toEqual([]);
  });
});
