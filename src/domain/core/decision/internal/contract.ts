import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';

export const DECISION_SCHEMA_VERSION = 1;
export const DECISION_ABSTENTIONS = Object.freeze(['none_of_the_above', 'insufficient_information'] as const);
export const DECISION_CASE_PREFIX = 'deckent.decision-case.v1\n';
export const DECISION_ADVICE_PREFIX = 'deckent.decision-advice.v1\n';
const text = z.string().min(1);
const texts = z.array(text).readonly();
const ids = z.array(identitySchema).readonly();
const time = z.string().datetime({ offset: true });
const unit = z.number().finite().min(0).max(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const decisionPolicySchema = z.object({ schemaVersion: z.literal(1),
  limits: z.object({ maxCaseBytes: counterSchema.positive(), maxEvidence: counterSchema.positive(),
    maxOptions: counterSchema.positive(), maxChecks: counterSchema.positive(), maxTextBytes: counterSchema.positive() }).strict().readonly(),
  thresholds: z.object({ choice: unit, sufficiency: unit }).strict().readonly(),
}).strict().readonly();
export const decisionCaseSchema = z.object({ schemaVersion: z.literal(1), objective: text,
  scope: identitySchema, revision: identitySchema, constraints: texts, unknowns: texts,
  evidence: z.array(z.object({ id: identitySchema, source: text, observedAt: time, observation: text }).strict().readonly()).readonly(),
  options: z.array(z.object({ id: identitySchema, action: text, tradeoffs: texts, evidenceIds: ids }).strict().readonly()).min(1).readonly(),
  checks: z.array(z.object({ id: identitySchema, instructions: text, evidenceIds: ids }).strict().readonly()).readonly(),
  'process': z.object({ stage: text, currentState: text, acceptedDecisions: texts, nextStep: text, reopenReason: text.nullable() }).strict().readonly(),
}).strict().superRefine((value, context) => {
  const duplicate = [value.evidence, value.options, value.checks].some(entries => new Set(entries.map(entry => entry.id)).size !== entries.length);
  if (duplicate || value.options.some(option => (DECISION_ABSTENTIONS as readonly string[]).includes(option.id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'DECISION_CASE_INVALID' });
  }
}).readonly();
export const decisionAdviceSchema = z.object({ schemaVersion: z.literal(1), choice: identitySchema,
  probabilities: z.record(identitySchema, unit).readonly(), confidence: unit, sufficiency: unit,
  checks: z.record(identitySchema, unit).readonly(), model: identitySchema,
  usage: z.object({ inputTokens: counterSchema, outputTokens: counterSchema }).strict().readonly(), latencyMs: counterSchema,
}).strict().superRefine((advice, context) => {
  const sum = Object.values(advice.probabilities).reduce((total, value) => total + value, 0);
  if (!DECISION_ABSTENTIONS.every(id => Object.hasOwn(advice.probabilities, id))
    || !Object.hasOwn(advice.probabilities, advice.choice) || Math.abs(sum - 1) > 0.000001
    || Object.values(advice.probabilities).some(value => value > advice.probabilities[advice.choice]!)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'DECISION_ADVICE_INVALID' });
  }
}).readonly();
/** A selected option is recorded data. This contract deliberately carries no execution authorization. */
export const decisionRecordSchema = z.object({ schemaVersion: z.literal(1), id: identitySchema, scope: identitySchema,
  caseDigest: digest, adviceRef: z.object({ invocationId: identitySchema, adviceDigest: digest }).strict().readonly(),
  actor: z.object({ principalId: identitySchema, selectedOption: identitySchema, rationale: text, decidedAt: time }).strict().readonly(),
  outcome: z.object({ principalId: identitySchema, observedAt: time, observation: text }).strict().readonly().nullable(),
}).strict().readonly();
export type DecisionPolicy = z.infer<typeof decisionPolicySchema>;
export type DecisionCase = z.infer<typeof decisionCaseSchema>;
export type DecisionAdvice = z.infer<typeof decisionAdviceSchema>;
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;
export type DecisionErrorCode = 'DECISION_POLICY_INVALID' | 'DECISION_CASE_INVALID' | 'DECISION_EVIDENCE_FUTURE'
  | 'DECISION_EVIDENCE_REFERENCE_INVALID' | 'DECISION_LIMIT_EXCEEDED' | 'DECISION_ADVICE_INVALID' | 'DECISION_RECORD_INVALID';
export class DecisionError extends Error {
  constructor(readonly code: DecisionErrorCode) { super(code); this.name = 'DecisionError'; }
}
