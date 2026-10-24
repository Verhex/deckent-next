import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { exactModelIdSchema, makersIndependent } from '#domain/core/provider-catalog/index.js';
import { MemoryError } from './contract.js';
import type { MemoryAutomation } from './automation.js';

/**
 * S4B-3 independent evaluation (S4B-DESIGN rev 4 §6, owner S-M3/S-M4/S-M5/S-M10 2026-10-23). A record judges exactly one stored candidate revision
 * (`subjectDigest` = its keyed content digest) on one evaluator model whose canonical maker differs from every source worker model's, re-derived
 * from the sealed Runs (never from support rows). Digests only, never content. `shadow` records are evidence for the rollout gate and never a
 * verification basis. Storage-neutral JSON like the journal.
 */
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly();
/** One model as the catalog names it, with its canonical maker (`null`: unknown — provider-chosen, no metadata or not in the catalog). */
export const memoryModelRefSchema = z.object({ channelId: identitySchema, modelId: exactModelIdSchema, maker: identitySchema.nullable() }).strict().readonly();
export type MemoryModelRef = z.infer<typeof memoryModelRefSchema>;
const attemptRefSchema = z.object({ runId: identitySchema, taskId: identitySchema, attemptId: identitySchema }).strict().readonly();
export const MEMORY_EVALUATION_VERDICTS = Object.freeze(['pass', 'fail', 'unknown'] as const);
/** A shadow record is rollout evidence only; a live one may be a verification basis. */
export const MEMORY_EVALUATION_MODES = Object.freeze(['shadow', 'live'] as const);
export type MemoryEvaluationVerdict = typeof MEMORY_EVALUATION_VERDICTS[number];
/** What the call cost, exactly as the spend ledger settled it; `none`: no money moved (a subscription or local channel, or nothing sent);
 * `unknown`: not settled or unreadable — the evaluator then stops for the day (fail closed). */
export const memoryEvaluationSpendSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('settled'), minorUnits: counterSchema, currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  z.object({ state: z.literal('none') }).strict(), z.object({ state: z.literal('unknown') }).strict()]).readonly();
export type MemoryEvaluationSpend = z.infer<typeof memoryEvaluationSpendSchema>;
const list = (max: number) => z.array(identitySchema).max(max).refine(values => new Set(values).size === values.length).readonly();
export const memoryEvaluationRecordSchema = z.object({ schemaVersion: z.literal(1), recordId: identitySchema, scopeId: identitySchema, entryId: identitySchema,
  entryRevision: counterSchema.positive(), subjectDigest: digest, mode: z.enum(MEMORY_EVALUATION_MODES), method: z.literal('model-review'), evaluator: actor,
  evaluatorModel: memoryModelRefSchema, sourceModels: z.array(memoryModelRefSchema).min(1).max(64).readonly(), sourceAttempts: z.array(attemptRefSchema).min(1).max(64).readonly(),
  sourceEvaluationIds: list(64), template: z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly(), registryRevision: identitySchema,
  inputDigest: digest, outputDigest: digest.nullable(), invocationId: identitySchema.nullable(), spend: memoryEvaluationSpendSchema,
  verdict: z.enum(MEMORY_EVALUATION_VERDICTS), reasonCodes: list(32), conflicts: list(32), failure: identitySchema.nullable(), atMs: counterSchema }).strict()
  .refine(record => record.verdict === 'unknown' ? record.conflicts.length === 0 && record.failure !== null : record.failure === null).readonly();
export type MemoryEvaluationRecord = z.infer<typeof memoryEvaluationRecordSchema>;
export const parseMemoryEvaluationRecord = (value: unknown): MemoryEvaluationRecord => {
  const parsed = memoryEvaluationRecordSchema.safeParse(value);
  if (!parsed.success) throw new MemoryError('MEMORY_ENTRY_INVALID');
  return parsed.data;
};
/** S4B-3 A9: a contest withdraws a verified entry from model context until a person resolves it (S4B-4); it changes no entry state. */
export const memoryContestSchema = z.object({ schemaVersion: z.literal(1), contestId: identitySchema, scopeId: identitySchema, entryId: identitySchema,
  candidateEntryId: identitySchema, evaluationRecordId: identitySchema, evaluationDigest: digest, openedBy: actor, reasonCode: identitySchema, openedAtMs: counterSchema }).strict().readonly();
export type MemoryContest = z.infer<typeof memoryContestSchema>;

/** The evaluator's whole answer: exactly this object, nothing else (`evaluate@1`). */
const answerSchema = (automation: MemoryAutomation, offered: readonly string[]) => z.object({ schemaVersion: z.literal(1), entryId: identitySchema, subjectDigest: digest,
  verdict: z.enum(MEMORY_EVALUATION_VERDICTS), reasonCodes: list(automation.evaluation.reasonCodesMax).refine(codes => codes.every(code => automation.reasonCodes.includes(code))),
  conflicts: list(automation.evaluation.conflictsMax).refine(ids => ids.every(id => offered.includes(id))) }).strict();
export type MemoryEvaluatorAnswer = { readonly verdict: MemoryEvaluationVerdict; readonly reasonCodes: readonly string[]; readonly conflicts: readonly string[]; readonly failure: string | null };
const unknown = (failure: string): MemoryEvaluatorAnswer => Object.freeze({ verdict: 'unknown', reasonCodes: [], conflicts: [], failure });
/**
 * §6.2 step 3–4: the answer text is accepted only as the strict schema with the exact echo of the entry id and the keyed subject digest the
 * application sent, reason codes from the registry and conflicts only among the offered ids. Anything else is `unknown` (never re-asked). A
 * model `unknown` stays a verdict without conflicts.
 */
export function readMemoryEvaluatorAnswer(text: string, expected: { readonly entryId: string; readonly subjectDigest: string; readonly offered: readonly string[] },
  automation: MemoryAutomation): MemoryEvaluatorAnswer {
  if (new TextEncoder().encode(text).length > automation.evaluation.outputMaxBytes) return unknown('MEMORY_EVALUATION_ANSWER_TOO_LARGE');
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { return unknown('MEMORY_EVALUATION_ANSWER_INVALID'); }
  const parsed = answerSchema(automation, expected.offered).safeParse(value);
  if (!parsed.success) return unknown('MEMORY_EVALUATION_ANSWER_INVALID');
  if (parsed.data.entryId !== expected.entryId || parsed.data.subjectDigest !== expected.subjectDigest) return unknown('MEMORY_EVALUATION_ECHO_MISMATCH');
  if (parsed.data.verdict === 'unknown') return unknown('MEMORY_EVALUATION_MODEL_UNKNOWN');
  return Object.freeze({ verdict: parsed.data.verdict, reasonCodes: parsed.data.reasonCodes, conflicts: parsed.data.verdict === 'pass' ? parsed.data.conflicts : [], failure: null });
}
/** A9/§6.5: only a `pass` record that lists conflicts opens contests (N26: never a `fail` or `unknown` one); the daily bound is the engine's. */
export const memoryContestTargets = (record: MemoryEvaluationRecord): readonly string[] => record.verdict === 'pass' ? record.conflicts : [];

const modelKey = (model: MemoryModelRef) => JSON.stringify([model.channelId, model.modelId, model.maker]);
const sameModels = (left: readonly MemoryModelRef[], right: readonly MemoryModelRef[]) => {
  const a = [...new Set(left.map(modelKey))].sort(), b = [...new Set(right.map(modelKey))].sort();
  return a.length === b.length && a.every((key, index) => key === b[index]);
};
/**
 * §6.3 independence, bound to the sealed Runs: the record's source models must equal the set the engine re-derived at verification (N22), every
 * maker must be known (N30: provider-chosen or missing metadata fails closed) and the evaluator's canonical maker must differ from each (same-maker sources, a single connected maker).
 */
export function assertMemoryEvaluationIndependent(record: { readonly evaluatorModel: MemoryModelRef; readonly sourceModels: readonly MemoryModelRef[] },
  rederived: readonly MemoryModelRef[] | null): void {
  if (!rederived || rederived.length === 0 || !sameModels(record.sourceModels, rederived)) throw new MemoryError('MEMORY_EVALUATION_NOT_INDEPENDENT');
  const sources = rederived.map(model => model.maker);
  if (record.evaluatorModel.maker === null || sources.some(maker => maker === null)) throw new MemoryError('MEMORY_EVALUATION_MAKER_UNKNOWN');
  if (!makersIndependent(record.evaluatorModel.maker, sources)) throw new MemoryError('MEMORY_EVALUATION_NOT_INDEPENDENT');
}
