import { describe, expect, it } from 'vitest';
import { decisionRecordSchema, prepareDecisionCase, validateDecisionAdvice, DecisionError,
  type DecisionPolicy } from '#domain/index.js';

const now = Date.parse('2026-10-02T12:00:00Z');
const policy: DecisionPolicy = { schemaVersion: 1,
  limits: { maxCaseBytes: 16_384, maxEvidence: 8, maxOptions: 8, maxChecks: 8, maxTextBytes: 1_024 },
  thresholds: { choice: 0.8, sufficiency: 0.7 } };
function caseInput() { return { schemaVersion: 1, objective: 'Choose bounded implementation', scope: 'company:project', revision: 'r1',
  constraints: ['No live effects'], unknowns: ['Runtime behavior'],
  evidence: [{ id: 'e1', source: 'proof/file', observedAt: '2026-10-02T11:00:00Z', observation: 'Source inspected' }],
  options: [{ id: 'a', action: 'Use the shared owner', tradeoffs: ['More wiring'], evidenceIds: ['e1'] }],
  checks: [{ id: 'c1', instructions: 'Scope is bounded', evidenceIds: ['e1'] }],
  process: { stage: 'implementation', currentState: 'prepared', acceptedDecisions: ['Port only'], nextStep: 'Review', reopenReason: null } }; }
function adviceInput() { return { schemaVersion: 1, choice: 'a', probabilities: { a: 0.9, none_of_the_above: 0.05, insufficient_information: 0.05 },
  confidence: 0.8, sufficiency: 0.75, checks: { c1: 0.9 }, model: 'configured-model',
  usage: { inputTokens: 100, outputTokens: 12 }, latencyMs: 20 }; }

describe('versioned vendor-neutral decision contracts', () => {
  it('prepares stable canonical data independent of input property order', () => {
    const first = prepareDecisionCase(caseInput(), policy, now);
    const reordered = Object.fromEntries(Object.entries(caseInput()).reverse());
    expect(prepareDecisionCase(reordered, policy, now).canonicalCase).toBe(first.canonicalCase);
    expect(first.case.options[0]?.evidenceIds).toEqual(['e1']);
  });
  it('rejects future evidence even one millisecond beyond observed time', () => {
    const input = caseInput(); input.evidence[0]!.observedAt = '2026-10-02T12:00:00.001Z';
    expect(() => prepareDecisionCase(input, policy, now)).toThrow('DECISION_EVIDENCE_FUTURE');
  });
  it('rejects nonexistent evidence references and duplicate ids', () => {
    const input = caseInput(); input.options[0]!.evidenceIds = ['missing'];
    expect(() => prepareDecisionCase(input, policy, now)).toThrow('DECISION_EVIDENCE_REFERENCE_INVALID');
    input.options[0]!.evidenceIds = ['e1']; input.evidence.push({ ...input.evidence[0]! });
    expect(() => prepareDecisionCase(input, policy, now)).toThrow('DECISION_CASE_INVALID');
  });
  it('reserves abstentions outside actor-authored options', () => {
    const input = caseInput(); input.options[0]!.id = 'insufficient_information';
    expect(() => prepareDecisionCase(input, policy, now)).toThrow(DecisionError);
  });
  it('enforces configured counts and UTF-8 byte limits rather than characters', () => {
    expect(() => prepareDecisionCase(caseInput(), { ...policy, limits: { ...policy.limits, maxCaseBytes: 4 } }, now)).toThrow('DECISION_LIMIT_EXCEEDED');
    const input = caseInput(); input.objective = 'ğ'.repeat(513);
    expect(() => prepareDecisionCase(input, policy, now)).toThrow('DECISION_LIMIT_EXCEEDED');
    input.objective = 'Objective'; input.options.push({ ...input.options[0]!, id: 'b' });
    expect(() => prepareDecisionCase(input, { ...policy, limits: { ...policy.limits, maxOptions: 1 } }, now)).toThrow('DECISION_LIMIT_EXCEEDED');
  });
  it('does not invoke hostile input getters', () => {
    let accessed = false;
    const input = { ...caseInput() }; Object.defineProperty(input, 'objective', { enumerable: true, get() { accessed = true; return 'Injected'; } });
    expect(() => prepareDecisionCase(input, policy, now)).toThrow(DecisionError); expect(accessed).toBe(false);
  });
  it('requires complete distribution including both abstentions and every option', () => {
    const input = adviceInput(); delete (input.probabilities as Record<string, number>)['insufficient_information'];
    expect(() => validateDecisionAdvice(input, caseInput(), policy)).toThrow('DECISION_ADVICE_INVALID');
  });
  it('rejects invented probability/check ids and invalid distribution sum', () => {
    expect(() => validateDecisionAdvice({ ...adviceInput(), checks: { other: 1 } }, caseInput(), policy)).toThrow('DECISION_ADVICE_INVALID');
    expect(() => validateDecisionAdvice({ ...adviceInput(), probabilities: { a: 1, none_of_the_above: 1, insufficient_information: 1 } }, caseInput(), policy)).toThrow('DECISION_ADVICE_INVALID');
  });
  it('derives below-threshold only from authored choice and sufficiency policy', () => {
    expect(validateDecisionAdvice(adviceInput(), caseInput(), policy).status).toBe('advised');
    expect(validateDecisionAdvice(adviceInput(), caseInput(), { ...policy, thresholds: { choice: 0.95, sufficiency: 0.7 } }).status).toBe('below-threshold');
    expect(validateDecisionAdvice(adviceInput(), caseInput(), { ...policy, thresholds: { choice: 0.8, sufficiency: 0.8 } }).status).toBe('below-threshold');
    expect(validateDecisionAdvice({ ...adviceInput(), sufficiency: 0.7 }, caseInput(), policy).status).toBe('advised');
  });
  it('preserves abstention advice without inventing an option', () => {
    const advice = { ...adviceInput(), choice: 'none_of_the_above', probabilities: { a: 0.05, none_of_the_above: 0.9, insufficient_information: 0.05 } };
    expect(validateDecisionAdvice(advice, caseInput(), policy).advice.choice).toBe('none_of_the_above');
  });
  it('actor records cannot contain an authority grant', () => {
    const record = { schemaVersion: 1, id: 'd1', scope: 'company:project', caseDigest: 'a'.repeat(64),
      adviceRef: { invocationId: 'i1', adviceDigest: 'b'.repeat(64) },
      actor: { principalId: 'human:owner', selectedOption: 'a', rationale: 'Bounded scope', decidedAt: '2026-10-02T12:00:00Z' }, outcome: null };
    expect(decisionRecordSchema.safeParse(record).success).toBe(true);
    expect(decisionRecordSchema.safeParse({ ...record, authority: 'allow' }).success).toBe(false);
  });
});

describe('decision policy layers', () => {
  it('fails without authored thresholds rather than filling policy from code', () => {
    expect(() => prepareDecisionCase(caseInput(), { ...policy, thresholds: undefined }, now)).toThrow('DECISION_POLICY_INVALID');
  });
  it('rejects unknown schema revisions without silent conversion', () => {
    expect(() => prepareDecisionCase({ ...caseInput(), schemaVersion: 2 }, policy, now)).toThrow('DECISION_CASE_INVALID');
  });
});


describe('pure observation time and maximal choice', () => {
  it('compares timezone offsets and leap-day evidence without a host clock', () => {
    const input = caseInput(); input.evidence[0]!.observedAt = '2026-10-02T15:00:00+03:00';
    expect(() => prepareDecisionCase(input, policy, now)).not.toThrow();
    input.evidence[0]!.observedAt = '2024-02-29T12:30:00-0230';
    expect(() => prepareDecisionCase(input, policy, Date.parse('2024-02-29T15:00:00Z'))).not.toThrow();
    input.evidence[0]!.observedAt = '2026-10-02T12:00:00.000000001Z';
    expect(() => prepareDecisionCase(input, policy, now)).toThrow('DECISION_EVIDENCE_FUTURE');
  });
  it('rejects invalid UTC offsets rather than treating them as unobserved', () => {
    const input = caseInput(); input.evidence[0]!.observedAt = '2026-10-02T12:00:00+99:99';
    expect(() => prepareDecisionCase(input, policy, now)).toThrow('DECISION_CASE_INVALID');
  });
  it('rejects a choice with lower probability than another answer', () => {
    expect(() => validateDecisionAdvice({ ...adviceInput(), choice: 'none_of_the_above' }, caseInput(), policy)).toThrow('DECISION_ADVICE_INVALID');
  });
});
