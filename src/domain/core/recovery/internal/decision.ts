import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import seed from '../../../../../assets/recovery/decision.json' with { type: 'json' };
import { RECOVERY_CAUSE_CLASSES, recoveryNoteCodeSchema } from './case.js';

/** S6R-DESIGN §6: the only actions a recovery decision may choose (versioned code, never registry data); the gate decides which are offered. */
export const RECOVERY_DECISION_ACTIONS = Object.freeze(['continue-new-attempt', 'escalate-human'] as const);
export type RecoveryDecisionAction = typeof RECOVERY_DECISION_ACTIONS[number];
const positive = counterSchema.positive();
/**
 * S6R-5 (S6R-DESIGN §6, §8; owner Q-R1/Q-R2): the recovery-decision registry, versioned Core data (`assets/recovery/decision.json`), every bound
 * provisional until measured (K-F S8). `template` names the current prompt among the versioned `templates` (`id@version` is sealed with each call);
 * `noteCodes` the codes a decision may pass on with their worker-facing text; `answer` the strict answer bounds; `call` the completion cap of the one
 * call (retries 0); `breaker` the per-process circuit breaker (more model decisions than this in the window: escalate without a call); `pass` the
 * detection page one pass reads and the most cases it keeps waiting for their release. No model, provider or vendor name is data here.
 */
export const recoveryDecisionRegistrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, status: z.enum(['provisional', 'measured']),
  template: z.object({ id: identitySchema, version: positive }).strict().readonly(),
  templates: z.array(z.object({ id: identitySchema, version: positive, text: z.string().min(1).max(8192) }).strict().readonly()).min(1).max(32).readonly(),
  noteCodes: z.array(z.object({ code: recoveryNoteCodeSchema, text: z.string().min(1).max(512) }).strict().readonly()).min(1).max(64).readonly(),
  answer: z.object({ maxBytes: positive, rationaleMaxChars: positive }).strict().readonly(),
  call: z.object({ maxCompletionTokens: positive }).strict().readonly(),
  breaker: z.object({ maxCasesPerWindow: counterSchema, windowMs: positive }).strict().readonly(),
  pass: z.object({ pageSize: positive, maxPending: positive }).strict().readonly(),
}).strict().superRefine((value, context) => {
  if (!value.templates.some(row => row.id === value.template.id && row.version === value.template.version)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['template'], message: 'RECOVERY_TEMPLATE_UNKNOWN' });
  if (new Set(value.templates.map(row => `${row.id}@${row.version}`)).size !== value.templates.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['templates'], message: 'RECOVERY_TEMPLATE_DUPLICATE' });
  if (new Set(value.noteCodes.map(row => row.code)).size !== value.noteCodes.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['noteCodes'], message: 'RECOVERY_NOTE_DUPLICATE' });
}).readonly();
export type RecoveryDecisionRegistry = z.infer<typeof recoveryDecisionRegistrySchema>;
export const RECOVERY_DECISION_SEED: unknown = Object.freeze(seed);
export function loadRecoveryDecisionRegistry(input: unknown): RecoveryDecisionRegistry { return recoveryDecisionRegistrySchema.parse(input); }
/** The current template of a registry (its id, version and text). */
export function recoveryDecisionTemplate(registry: RecoveryDecisionRegistry) {
  const row = registry.templates.find(template => template.id === registry.template.id && template.version === registry.template.version)!;
  return Object.freeze({ id: row.id, version: row.version, text: row.text });
}
/** The worker-facing text of a note code (null: not a code of this registry). */
export const recoveryNoteText = (registry: RecoveryDecisionRegistry, code: string) => registry.noteCodes.find(row => row.code === code)?.text ?? null;

export const RECOVERY_DECISION_FAILURES = Object.freeze(['answer-too-large', 'answer-invalid', 'echo-mismatch', 'action-not-offered', 'note-invalid'] as const);
export type RecoveryDecisionFailure = typeof RECOVERY_DECISION_FAILURES[number];
export type RecoveryDecisionAnswer = Readonly<{ ok: true; action: RecoveryDecisionAction; causeClass: typeof RECOVERY_CAUSE_CLASSES[number]; note: string | null; rationale: string }>
  | Readonly<{ ok: false; failure: RecoveryDecisionFailure }>;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** The answer contract the template names (`answerSchema` in the request is its plain description). */
export const recoveryDecisionAnswerShape = Object.freeze({ schemaVersion: 1, caseId: 'string', evidenceDigest: 'string', action: RECOVERY_DECISION_ACTIONS.join('|'),
  causeClass: RECOVERY_CAUSE_CLASSES.join('|'), rationale: 'string', nextAttemptNote: 'string|null' });

/**
 * Pure (S6R-DESIGN §6 validation; N9, N16, N26): the strict reading of the model's one answer. Exactly one JSON object of the answer schema (no
 * surrounding text), within the registry byte and rationale bounds, echoing the sealed case id and evidence digest, choosing an offered action,
 * and naming either no note or one registry note code (escalate-human: none). Anything else is a typed failure; the caller escalates and never re-asks.
 */
export function readRecoveryDecisionAnswer(text: string, expected: Readonly<{ caseId: string; evidenceDigest: string; offered: readonly string[] }>,
  registry: RecoveryDecisionRegistry): RecoveryDecisionAnswer {
  const fail = (failure: RecoveryDecisionFailure) => Object.freeze({ ok: false as const, failure });
  if (new TextEncoder().encode(text).length > registry.answer.maxBytes) return fail('answer-too-large');
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { return fail('answer-invalid'); }
  const parsed = z.object({ schemaVersion: z.literal(1), caseId: digest, evidenceDigest: digest, action: z.enum(RECOVERY_DECISION_ACTIONS), causeClass: z.enum(RECOVERY_CAUSE_CLASSES),
    rationale: z.string().max(registry.answer.rationaleMaxChars), nextAttemptNote: z.string().nullable() }).strict().safeParse(value);
  if (!parsed.success) return fail('answer-invalid');
  const answer = parsed.data;
  if (answer.caseId !== expected.caseId || answer.evidenceDigest !== expected.evidenceDigest) return fail('echo-mismatch');
  if (!expected.offered.includes(answer.action)) return fail('action-not-offered');
  if (answer.nextAttemptNote !== null && (answer.action !== 'continue-new-attempt' || recoveryNoteText(registry, answer.nextAttemptNote) === null)) return fail('note-invalid');
  return Object.freeze({ ok: true as const, action: answer.action, causeClass: answer.causeClass, note: answer.nextAttemptNote, rationale: answer.rationale });
}
