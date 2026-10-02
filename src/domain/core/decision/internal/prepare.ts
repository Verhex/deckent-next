import { decisionObservationIsFuture } from './observed-time.js';
import { z } from 'zod';
import { createImmutableJsonObjectSchema } from '#domain/core/primitives/index.js';
import { DECISION_ABSTENTIONS, DECISION_ADVICE_PREFIX, DECISION_CASE_PREFIX, DecisionError,
  decisionAdviceSchema, decisionCaseSchema, decisionPolicySchema, decisionRecordSchema,
  type DecisionAdvice, type DecisionCase, type DecisionErrorCode, type DecisionPolicy, type DecisionRecord } from './contract.js';

// These are descriptor-safe wire invariants, not customer policy or admission thresholds.
const wire = createImmutableJsonObjectSchema({ maxDepth: 16, maxNodes: 262_144, maxCodeUnits: 8 * 1024 * 1024 });
function parse<T>(schema: z.ZodType<T>, input: unknown, code: DecisionErrorCode): T {
  const copied = wire.safeParse(input), parsed = copied.success ? schema.safeParse(copied.data) : undefined;
  if (!parsed?.success) throw new DecisionError(code);
  return parsed.data;
}
export const parseDecisionPolicy = (input: unknown): DecisionPolicy => parse(decisionPolicySchema, input, 'DECISION_POLICY_INVALID');
export const parseDecisionCase = (input: unknown): DecisionCase => parse(decisionCaseSchema, input, 'DECISION_CASE_INVALID');
export const parseDecisionAdvice = (input: unknown): DecisionAdvice => parse(decisionAdviceSchema, input, 'DECISION_ADVICE_INVALID');
export const parseDecisionRecord = (input: unknown): DecisionRecord => parse(decisionRecordSchema, input, 'DECISION_RECORD_INVALID');
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
function bytes(value: string): number {
  let count = 0;
  for (const char of value) { const code = char.codePointAt(0)!; count += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
  return count;
}
function assertTextBudget(value: unknown, maxBytes: number): void {
  if (typeof value === 'string' && bytes(value) > maxBytes) throw new DecisionError('DECISION_LIMIT_EXCEEDED');
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) assertTextBudget(child, maxBytes);
  }
}
export function prepareDecisionCase(input: unknown, policyInput: unknown, nowMs: number): Readonly<{ case: DecisionCase; canonicalCase: string }> {
  const policy = parseDecisionPolicy(policyInput), decisionCase = parseDecisionCase(input), limits = policy.limits;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new DecisionError('DECISION_CASE_INVALID');
  const encoded = canonical(decisionCase);
  if (decisionCase.evidence.length > limits.maxEvidence || decisionCase.options.length > limits.maxOptions
    || decisionCase.checks.length > limits.maxChecks || bytes(encoded) > limits.maxCaseBytes) throw new DecisionError('DECISION_LIMIT_EXCEEDED');
  assertTextBudget(decisionCase, limits.maxTextBytes);
  if (decisionCase.evidence.some(entry => decisionObservationIsFuture(entry.observedAt, nowMs))) throw new DecisionError('DECISION_EVIDENCE_FUTURE');
  const evidenceIds = new Set(decisionCase.evidence.map(entry => entry.id));
  if ([...decisionCase.options, ...decisionCase.checks].some(entry => entry.evidenceIds.some(id => !evidenceIds.has(id)))) {
    throw new DecisionError('DECISION_EVIDENCE_REFERENCE_INVALID');
  }
  return Object.freeze({ case: decisionCase, canonicalCase: `${DECISION_CASE_PREFIX}${encoded}` });
}
function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value); return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
export function validateDecisionAdvice(input: unknown, caseInput: unknown, policyInput: unknown): Readonly<{
  advice: DecisionAdvice; status: 'advised' | 'below-threshold';
}> {
  const advice = parseDecisionAdvice(input), decisionCase = parseDecisionCase(caseInput), policy = parseDecisionPolicy(policyInput);
  const options = [...decisionCase.options.map(option => option.id), ...DECISION_ABSTENTIONS];
  const total = Object.values(advice.probabilities).reduce((sum, value) => sum + value, 0);
  // Tolerance accounts only for finite JSON decimal representation; it is not an admission threshold.
  if (!options.includes(advice.choice) || !exactKeys(advice.probabilities, options)
    || !exactKeys(advice.checks, decisionCase.checks.map(check => check.id)) || Math.abs(total - 1) > 0.000001) {
    throw new DecisionError('DECISION_ADVICE_INVALID');
  }
  const below = advice.probabilities[advice.choice]! < policy.thresholds.choice || advice.sufficiency < policy.thresholds.sufficiency;
  return Object.freeze({ advice, status: below ? 'below-threshold' : 'advised' });
}
export function encodeDecisionAdvice(input: unknown): string { return `${DECISION_ADVICE_PREFIX}${canonical(parseDecisionAdvice(input))}`; }
