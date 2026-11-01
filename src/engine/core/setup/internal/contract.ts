import { persistedString, persistedInteger, identitySchema, type JsonValue } from '#domain/index.js';
import { LOCALES } from '#platform/index.js';
import { z } from 'zod';


/** Versioned setup-plan contract (alpha.48 I-S1). The plan is pure and locale-free: titles, questions and reasons are message keys. */
export const SETUP_PLAN_SCHEMA_VERSION = 2 as const;
export const SETUP_STAGE_STATES = ['done', 'ready', 'needs-answer', 'blocked', 'skipped', 'unsupported'] as const;
export type SetupStageState = typeof SETUP_STAGE_STATES[number];
/** Generic Core stages only. Execution-environment, source-control and business-system stages are family registrations. */
export const CORE_SETUP_STAGES = ['core:environment', 'core:language', 'core:folder', 'core:profile', 'core:policy', 'core:sandbox', 'core:model', 'core:final-check'] as const;
export type CoreSetupStageId = typeof CORE_SETUP_STAGES[number];
/** alpha.56 U3-1a: `install` stages are what `deckent init` plans and applies; `onboarding` stages are offered on the first open (terminal, Desktop). */
export const SETUP_PHASES = ['install', 'onboarding'] as const;
export type SetupPhase = typeof SETUP_PHASES[number];

const locale = z.enum(LOCALES);
const scope = identitySchema.nullable();
/** One identity profile by id and version (template data, never authority). */
export const setupProfileRefSchema = z.strictObject({ id: identitySchema, get version() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER); } });
/** Core facts from read-only observation ports. Family facts stay opaque here and are validated by the family's own schema. */
export const setupObservationSchema = z.strictObject({
  get schemaVersion() { return z.literal(SETUP_PLAN_SCHEMA_VERSION); },
  get environment() { return z.strictObject({ platform: z.enum(['linux', 'wsl', 'windows', 'macos', 'other']), node: z.enum(['supported', 'below-floor']) }); },
  get language() { return z.strictObject({ configured: locale.nullable(), requested: locale.nullable(), system: locale.nullable() }); },
  get folder() { return z.strictObject({ installation: z.enum(['none', 'present', 'pending']), homeRoot: z.boolean(), configuredScope: scope, suggestedScope: scope }); },
  /** `selected`: the saved `identity.profile` (template data, never authority; any registered or custom package id), null when none is saved. */
  get profile() { return z.strictObject({ available: z.array(setupProfileRefSchema).max(256), selected: setupProfileRefSchema.nullable().prefault(null) }); },
  get policy() { return z.strictObject({ state: z.enum(['absent', 'current', 'upgradable', 'hand-built', 'conflict', 'pending']) }); },
  get sandbox() { return z.strictObject({ realm: z.enum(['bubblewrap', 'landlock', 'none']), selfTest: z.enum(['ok', 'failed', 'not-run']), usernsRestricted: z.boolean() }); },
  get model() { return z.strictObject({ connections: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }); },
  get check() { return z.strictObject({ state: z.enum(['ok', 'warnings', 'errors', 'not-run']) }); },
  get families() { return z.record(z.string(), z.unknown().optional()).prefault({}); },
});
export type SetupObservation = z.input<typeof setupObservationSchema>;
export type SetupObservationFacts = z.output<typeof setupObservationSchema>;

/** Answers are keyed by stage id; secret values never belong here (keys go through the hidden prompt or stdin). */
export const setupAnswersSchema = z.strictObject({ get schemaVersion() { return z.literal(SETUP_PLAN_SCHEMA_VERSION); },
  get values() { return z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/), z.unknown().optional()).prefault({}); } });
export type SetupAnswers = z.input<typeof setupAnswersSchema>;

const key = z.string().regex(/^[a-z][A-Za-z0-9_.-]{0,159}$/);
const params = z.record(z.string(), z.union([persistedString(z.string().max(512)), z.number().finite()])).prefault({});
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), persistedString(z.string().max(4096)),
  z.array(json).max(64), z.record(z.string(), json)]));
/** One existing owner's operation and its typed input; the setup sequences owners and never applies a state change itself. */
export const setupOperationSchema = z.strictObject({ get id() { return z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/); }, get version() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER); },
  get input() { return z.record(z.string(), json); } });
export type SetupOperation = z.output<typeof setupOperationSchema>;
/** What a stage evaluator decides; the planner adds identity, order and eligibility. */
export const setupDecisionSchema = z.strictObject({ get state() { return z.enum(SETUP_STAGE_STATES); }, get reason() { return z.strictObject({ code: key, params }); },
  get operation() { return setupOperationSchema.nullable().prefault(null); }, get question() { return z.strictObject({ key, params }).nullable().prefault(null); },
  get default() { return json.nullable().prefault(null); }, get cli() { return z.array(persistedString(z.string().min(1).max(512)).regex(/^\S+$/)).max(32).nullable().prefault(null); } });
export type SetupDecision = z.input<typeof setupDecisionSchema>;
export type SetupStage = Readonly<{ id: string; namespace: string; title: string; phase: SetupPhase; state: SetupStageState;
  reason: Readonly<{ code: string; params: Readonly<Record<string, string | number>> }>; operation: SetupOperation | null;
  question: Readonly<{ key: string; params: Readonly<Record<string, string | number>> }> | null; default: JsonValue | null;
  /** The exact long command for AI and scripts, one argv token per entry. */
  cli: readonly string[] | null; autoEligible: boolean }>;
export type SetupPlan = Readonly<{ schemaVersion: typeof SETUP_PLAN_SCHEMA_VERSION; registryDigest: string; stages: readonly SetupStage[]; planDigest: string }>;

/** What a family evaluator sees: its own validated facts, its answer, the scope and the states of every earlier stage. */
export type SetupStageContext = Readonly<{ facts: unknown; answer: unknown; scopeId: string | null; states: ReadonlyMap<string, SetupStageState>; prior?: ReadonlyMap<string, unknown> }>;
const stageId = z.string().regex(/^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/);
/** A family package: namespaced like identity-profile packages; Core is never shadowed. Stages carry pure evaluators, so the
 * package digest covers the descriptor data (namespace, source, ids, anchors, titles), not the function bodies. */
export const setupFamilyPackageSchema = z.strictObject({ get namespace() { return z.string().regex(/^[a-z][a-z0-9-]{0,63}$/); }, source: identitySchema,
  get facts() { return z.custom<z.ZodTypeAny>(value => value instanceof z.ZodType); },
  get stages() { return z.array(z.strictObject({ id: stageId, after: z.enum(CORE_SETUP_STAGES).refine(stage => stage !== 'core:final-check'), title: key, phase: z.enum(SETUP_PHASES).optional(),
    evaluate: z.custom<(context: SetupStageContext) => SetupDecision>(value => typeof value === 'function') })).min(1).max(32); } });
export type SetupFamilyPackage = z.input<typeof setupFamilyPackageSchema>;
