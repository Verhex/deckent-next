import { z } from 'zod';
import { identitySchema, type JsonValue } from '#domain/index.js';
import { LOCALES } from '#platform/index.js';

/** Versioned setup-plan contract (alpha.48 I-S1). The plan is pure and locale-free: titles, questions and reasons are message keys. */
export const SETUP_PLAN_SCHEMA_VERSION = 1 as const;
export const SETUP_STAGE_STATES = ['done', 'ready', 'needs-answer', 'blocked', 'skipped', 'unsupported'] as const;
export type SetupStageState = typeof SETUP_STAGE_STATES[number];
/** Generic Core stages only. Execution-environment, source-control and business-system stages are family registrations. */
export const CORE_SETUP_STAGES = ['core:environment', 'core:language', 'core:folder', 'core:profile', 'core:policy', 'core:sandbox', 'core:model', 'core:final-check'] as const;
export type CoreSetupStageId = typeof CORE_SETUP_STAGES[number];

const locale = z.enum(LOCALES);
const scope = identitySchema.nullable();
/** One identity profile by id and version (template data, never authority). */
export const setupProfileRefSchema = z.object({ id: identitySchema, version: z.number().int().positive().safe() }).strict();
/** Core facts from read-only observation ports. Family facts stay opaque here and are validated by the family's own schema. */
export const setupObservationSchema = z.object({
  schemaVersion: z.literal(SETUP_PLAN_SCHEMA_VERSION),
  environment: z.object({ platform: z.enum(['linux', 'wsl', 'windows', 'macos', 'other']), node: z.enum(['supported', 'below-floor']) }).strict(),
  language: z.object({ configured: locale.nullable(), requested: locale.nullable(), system: locale.nullable() }).strict(),
  folder: z.object({ installation: z.enum(['none', 'present', 'pending']), homeRoot: z.boolean(), configuredScope: scope, suggestedScope: scope }).strict(),
  /** `selected`: the saved `identity.profile` (template data, never authority; any registered or custom package id), null when none is saved. */
  profile: z.object({ available: z.array(setupProfileRefSchema).max(256), selected: setupProfileRefSchema.nullable().default(null) }).strict(),
  policy: z.object({ state: z.enum(['absent', 'current', 'upgradable', 'hand-built', 'conflict', 'pending']) }).strict(),
  sandbox: z.object({ realm: z.enum(['bubblewrap', 'landlock', 'none']), selfTest: z.enum(['ok', 'failed', 'not-run']), usernsRestricted: z.boolean() }).strict(),
  model: z.object({ connections: z.number().int().nonnegative().safe() }).strict(),
  check: z.object({ state: z.enum(['ok', 'warnings', 'errors', 'not-run']) }).strict(),
  families: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type SetupObservation = z.input<typeof setupObservationSchema>;
export type SetupObservationFacts = z.output<typeof setupObservationSchema>;

/** Answers are keyed by stage id; secret values never belong here (keys go through the hidden prompt or stdin). */
export const setupAnswersSchema = z.object({ schemaVersion: z.literal(SETUP_PLAN_SCHEMA_VERSION),
  values: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/), z.unknown()).default({}) }).strict();
export type SetupAnswers = z.input<typeof setupAnswersSchema>;

const key = z.string().regex(/^[a-z][A-Za-z0-9_.-]{0,159}$/);
const params = z.record(z.string(), z.union([z.string().max(512), z.number().finite()])).default({});
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(4096),
  z.array(json).max(64), z.record(z.string(), json)]));
/** One existing owner's operation and its typed input; the setup sequences owners and never applies a state change itself. */
export const setupOperationSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/), version: z.number().int().positive().safe(),
  input: z.record(z.string(), json) }).strict();
export type SetupOperation = z.output<typeof setupOperationSchema>;
/** What a stage evaluator decides; the planner adds identity, order and eligibility. */
export const setupDecisionSchema = z.object({ state: z.enum(SETUP_STAGE_STATES), reason: z.object({ code: key, params }).strict(),
  operation: setupOperationSchema.nullable().default(null), question: z.object({ key, params }).strict().nullable().default(null),
  default: json.nullable().default(null), cli: z.array(z.string().min(1).max(512).regex(/^\S+$/)).max(32).nullable().default(null) }).strict();
export type SetupDecision = z.input<typeof setupDecisionSchema>;
export type SetupStage = Readonly<{ id: string; namespace: string; title: string; state: SetupStageState;
  reason: Readonly<{ code: string; params: Readonly<Record<string, string | number>> }>; operation: SetupOperation | null;
  question: Readonly<{ key: string; params: Readonly<Record<string, string | number>> }> | null; default: JsonValue | null;
  /** The exact long command for AI and scripts, one argv token per entry. */
  cli: readonly string[] | null; autoEligible: boolean }>;
export type SetupPlan = Readonly<{ schemaVersion: typeof SETUP_PLAN_SCHEMA_VERSION; registryDigest: string; stages: readonly SetupStage[]; planDigest: string }>;

/** What a family evaluator sees: its own validated facts, its answer, the scope and the states of every earlier stage. */
export type SetupStageContext = Readonly<{ facts: unknown; answer: unknown; scopeId: string | null; states: ReadonlyMap<string, SetupStageState> }>;
const stageId = z.string().regex(/^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/);
/** A family package: namespaced like identity-profile packages; Core is never shadowed. Stages carry pure evaluators, so the
 * package digest covers the descriptor data (namespace, source, ids, anchors, titles), not the function bodies. */
export const setupFamilyPackageSchema = z.object({ namespace: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), source: identitySchema,
  facts: z.custom<z.ZodTypeAny>(value => value instanceof z.ZodType),
  stages: z.array(z.object({ id: stageId, after: z.enum(CORE_SETUP_STAGES).refine(stage => stage !== 'core:final-check'), title: key,
    evaluate: z.custom<(context: SetupStageContext) => SetupDecision>(value => typeof value === 'function') }).strict()).min(1).max(32) }).strict();
export type SetupFamilyPackage = z.input<typeof setupFamilyPackageSchema>;
