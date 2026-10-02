import { z } from 'zod';
import type { ModelInvocationNativeResponse } from '#domain/index.js';
import { decisionAdviceSchema, type DecisionCase, type DecisionAdvice } from '#domain/index.js';
import { DecisionHttpError, decisionHttpProtocolData, decisionHttpWireObjectSchema } from './contract.js';

const probability = z.number().min(0).max(1);
const choiceSchema = z.object({ type: z.literal('choice'), choice: z.string().min(1), probabilities: z.record(z.string(), probability), confidence: probability }).strict();
const noulSchema = z.object({ type: z.literal('noul'), noul: probability }).strict();
const wireSchema = z.object({ model: z.string().min(1).max(1024), answers: z.record(z.string(), z.union([choiceSchema, noulSchema])),
  usage: z.object({ input_tokens: z.number().int().nonnegative().safe(), output_tokens: z.number().int().nonnegative().safe() }).strict() }).strict();
const sameKeys = (actual: readonly string[], expected: readonly string[]) => actual.length === expected.length && expected.every(key => actual.includes(key));

/** Strict protocol parse; no absent answers, distributions or abstentions are synthesized. */
export function decisionAdviceFromWire(input: unknown, caseValue: DecisionCase, latencyMs: number): DecisionAdvice | null {
  const copied = decisionHttpWireObjectSchema.safeParse(input), parsed = copied.success && wireSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) return null;
  const expectedQuestions = ['selection', 'sufficiency', ...caseValue.checks.map((_check, index) => `check_${index}`)];
  if (!sameKeys(Object.keys(parsed.data.answers), expectedQuestions)) return null;
  const selection = parsed.data.answers['selection'], sufficiency = parsed.data.answers['sufficiency'];
  if (!selection || selection.type !== 'choice' || !sufficiency || sufficiency.type !== 'noul') return null;
  const options = [...caseValue.options.map(option => option.id), ...Object.keys(decisionHttpProtocolData.abstentions)];
  // The probability-sum rule has one owner: decisionAdviceSchema below (Jev 6b8b4a9e, lead 2026-10-03).
  if (!sameKeys(Object.keys(selection.probabilities), options) || !options.includes(selection.choice)
    || selection.probabilities[selection.choice]! < Math.max(...Object.values(selection.probabilities))) return null;
  const checks: Record<string, number> = Object.create(null);
  for (const [index, check] of caseValue.checks.entries()) {
    const answer = parsed.data.answers[`check_${index}`]; if (!answer || answer.type !== 'noul') return null;
    checks[check.id] = answer.noul;
  }
  const advice = decisionAdviceSchema.safeParse({ schemaVersion: 1, choice: selection.choice, probabilities: selection.probabilities,
    confidence: selection.confidence, sufficiency: sufficiency.noul, checks, model: parsed.data.model,
    usage: { inputTokens: parsed.data.usage.input_tokens, outputTokens: parsed.data.usage.output_tokens }, latencyMs });
  return advice.success ? advice.data : null;
}

/** Read the normalized advice retained by the normal invocation receipt. */
export function parseDecisionHttpAdvice(response: unknown, caseValue: DecisionCase, latencyMs?: number): DecisionAdvice {
  const parsed = decisionHttpWireObjectSchema.safeParse(response);
  const adviceInput = parsed.success ? (parsed.data['native'] as ModelInvocationNativeResponse['native'] | undefined)?.['decisionAdvice'] : undefined;
  const advice = decisionAdviceSchema.safeParse(adviceInput);
  if (!advice.success || !sameKeys(Object.keys(advice.data.probabilities), [...caseValue.options.map(option => option.id), ...Object.keys(decisionHttpProtocolData.abstentions)])
    || !sameKeys(Object.keys(advice.data.checks), caseValue.checks.map(check => check.id))) throw new DecisionHttpError('DECISION_HTTP_RESPONSE_INVALID');
  return latencyMs === undefined ? advice.data : decisionAdviceSchema.parse({ ...advice.data, latencyMs });
}
