import { z } from 'zod';
import { attemptIdentitySchema, identitySchema, type WorkerModelVerdict } from '#domain/index.js';
import limits from './limits.json' with { type: 'json' };

/**
 * DeliverySummary v1 (TESLIM-KARTI-OZET, alpha.53 law-audit fold 4): one generic envelope every delivery/adoption card renders, built by
 * one engine application from authorized reads. Read projection only: never on the protocol wire, never an authority or acceptance input.
 * The `change` section is filled by the target's adapter (git workspace: files, +/−, top paths, out-of-scope); an ERP adapter fills its own.
 * Every optional section is typed `available | withheld` (the caller may not read it) `| unavailable` (no evidence); strings are bounded and redacted.
 */
export const DELIVERY_SUMMARY_LIMITS = Object.freeze(limits);
/** Bounded text counts code points (the `*Chars` limits, the projector's cut and the list cells agree; REVISE 2734 R4), so an astral character
 * never makes a correctly cut string fail the envelope. The UTF-16 ceiling (two units per code point) is checked first and keeps the count cheap. */
const text = (max: number, min = 0) => z.string().min(min).max(max * 2).refine(value => Array.from(value).length <= max);
const count = z.number().int().nonnegative().safe();
const withheld = z.object({ state: z.literal('withheld') }).strict();
const unavailable = z.object({ state: z.literal('unavailable') }).strict();

export const DELIVERY_SUMMARY_OPERATIONS = ['deliver', 'adopt', 'rollback'] as const;
export const deliverySummaryOperationSchema = z.enum(DELIVERY_SUMMARY_OPERATIONS);
export type DeliverySummaryOperation = z.infer<typeof deliverySummaryOperationSchema>;
/** Typed keys of what yes / no will do; surfaces render the words. */
export const DELIVERY_SUMMARY_ACTIONS = Object.freeze({
  deliver: Object.freeze({ yes: 'publish-candidate', no: 'nothing-published' }),
  adopt: Object.freeze({ yes: 'move-target', no: 'target-unchanged' }),
  rollback: Object.freeze({ yes: 'restore-previous', no: 'current-stays' }),
} as const);
const actionKeySchema = z.enum(['publish-candidate', 'nothing-published', 'move-target', 'target-unchanged', 'restore-previous', 'current-stays']);

/** Host verdicts of a pinned worker's model evidence (WORKER-CURRENCY-1/2, incl. the session-start-name and client-reported pairs) plus `pending`. */
export const DELIVERY_MODEL_VERDICTS = ['verified', 'substituted', 'unverified', 'start-name-matched', 'provider-chosen', 'client-reported', 'client-reported-mismatch', 'pending'] as const satisfies readonly WorkerModelVerdict[];
type MissingVerdict = Exclude<WorkerModelVerdict, typeof DELIVERY_MODEL_VERDICTS[number]>;
const exhaustiveVerdicts: MissingVerdict extends never ? true : never = true; void exhaustiveVerdicts;
export const deliveryModelVerdictSchema = z.enum(DELIVERY_MODEL_VERDICTS);
export const deliveryVerificationPhaseSchema = z.enum(['accepted', 'failed', 'pending', 'cancelled', 'unknown']);
export const deliveryEvidenceKindSchema = z.enum(['exit-code', 'operation-record', 'unknown']);
const evidenceSchema = z.object({ evaluator: z.object({ id: identitySchema, version: z.number().int().positive().safe() }).strict(),
  kind: deliveryEvidenceKindSchema, independent: z.boolean().nullable() }).strict();
export const DELIVERY_RISK_FLAGS = ['acceptance-unverified', 'evidence-not-independent', 'model-not-verified', 'worker-checks-failed',
  'verification-missing', 'verification-not-accepted', 'out-of-scope', 'scope-undeclared', 'protected-target', 'instruction-surface'] as const;
export const deliveryRiskFlagSchema = z.enum(DELIVERY_RISK_FLAGS);
export type DeliveryRiskFlag = z.infer<typeof deliveryRiskFlagSchema>;

/** Adapter-filled change facts, bounded by the projector. `adapter` names the filler (e.g. `workspace-patch`), never a vendor. */
export const deliveryChangeFactsSchema = z.object({ adapter: identitySchema, paths: z.array(z.string()).readonly(), added: count, removed: count,
  scope: z.enum(['in-scope', 'out-of-scope', 'unscoped']), outOfScope: z.array(z.string()).readonly(),
  /** G1: changed paths inside the target's agent instruction surface that the task scope does not name (delivery refuses them). */
  instructionSurface: z.array(z.string()).readonly().optional() }).strict().readonly();
export type DeliveryChangeFacts = z.infer<typeof deliveryChangeFactsSchema>;

export const deliverySummarySchema = z.object({ schemaVersion: z.literal(1), operation: deliverySummaryOperationSchema,
  subject: attemptIdentitySchema,
  target: z.discriminatedUnion('state', [z.object({ state: z.literal('available'), id: text(limits.targetChars), protected: z.boolean().nullable() }).strict(), unavailable]),
  /** Brain-authored work-input title, else the first instruction line, else untitled (surfaces render the word). */
  title: z.discriminatedUnion('source', [z.object({ source: z.enum(['work-input', 'instruction']), text: text(limits.titleChars, 1) }).strict(),
    z.object({ source: z.literal('untitled') }).strict()]),
  /** The worker's own report summary: a CLAIM, never acceptance. */
  outcome: z.discriminatedUnion('state', [z.object({ state: z.literal('available'), claim: z.literal(true), summary: text(limits.outcomeChars), truncated: z.boolean() }).strict(), withheld, unavailable]),
  acceptance: z.object({ verdict: z.enum(['accepted', 'accepted-unverified', 'not-accepted', 'pending']), criteriaCount: count,
    evidence: z.array(evidenceSchema).max(limits.evidenceKinds) }).strict(),
  tests: z.object({
    /** Worker-reported check outcomes (claim). */
    worker: z.discriminatedUnion('state', [z.object({ state: z.literal('available'), claim: z.literal(true), passed: count, failed: count, notRun: count, unknown: count }).strict(), withheld, unavailable]),
    /** The system's own verification Run (queue candidate): its phase and what its criteria rest on. */
    verification: z.discriminatedUnion('state', [z.object({ state: z.literal('available'), runId: identitySchema, phase: deliveryVerificationPhaseSchema,
      evidence: z.array(evidenceSchema).max(limits.evidenceKinds) }).strict(), withheld, unavailable]),
  }).strict(),
  model: z.discriminatedUnion('state', [z.object({ state: z.literal('available'), requested: z.object({ channelId: text(limits.modelChars), modelId: text(limits.modelChars) }).strict(),
    verdict: deliveryModelVerdictSchema }).strict(), withheld, unavailable]),
  risk: z.object({ class: z.enum(['small', 'other']), workClass: identitySchema.nullable(), protectedTarget: z.boolean().nullable(),
    sizeBucket: identitySchema.nullable(), flags: z.array(deliveryRiskFlagSchema).max(DELIVERY_RISK_FLAGS.length) }).strict(),
  actions: z.object({ yes: actionKeySchema, no: actionKeySchema }).strict(),
  change: z.discriminatedUnion('state', [z.object({ state: z.literal('available'), adapter: identitySchema, files: count, added: count, removed: count,
    topPaths: z.array(text(limits.pathChars)).max(limits.maxTopPaths), topPathsOmitted: count, scope: z.enum(['in-scope', 'out-of-scope', 'unscoped']),
    outOfScope: z.array(text(limits.pathChars)).max(limits.maxOutOfScopePaths), outOfScopeCount: count }).strict(), withheld, unavailable]),
}).strict();
export type DeliverySummary = z.infer<typeof deliverySummarySchema>;
