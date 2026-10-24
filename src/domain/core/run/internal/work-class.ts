import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { exactModelIdSchema, MODEL_TIERS, REASONING_EFFORTS, workerEffortSchema, type CatalogModel, type ReasoningEffort, type WorkerEffort } from '#domain/core/provider-catalog/index.js';
import asset from '../../../../../assets/native-coding/work-classes.json' with { type: 'json' };
import limits from './work-class-limits.json' with { type: 'json' };
import assignmentData from './work-class-assignment.json' with { type: 'json' };
/** Closed, business-neutral vocabulary: concrete evaluator/adapter semantics stay in their registries. */
export const criterionTypeSchema = z.enum(['completion', 'correctness', 'safety', 'authorization']);
export const coreEvidenceTypeSchema = z.enum(['retained-artifact', 'verification-result', 'operation-settlement', 'observed-readback', 'approval-receipt']);
export const evidenceTypeSchema = z.union([coreEvidenceTypeSchema, z.string().regex(/^ext:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)]);
const scoreSchema = z.number().finite().min(0).max(1);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
export const workClassAcceptanceProfileSchema = z.object({ schemaVersion: z.literal(1), version: z.number().int().positive().safe(),
  criterionTypes: z.array(criterionTypeSchema).min(1).max(4).readonly(),
  evidenceTypes: z.array(evidenceTypeSchema).min(1).max(256).readonly(),
  rubric: z.array(z.object({ criterionType: criterionTypeSchema, evidenceTypes: z.array(evidenceTypeSchema).min(1).max(256).readonly(),
    weight: scoreSchema.refine(value => value > 0),
  }).strict().readonly()).min(1).max(4).readonly(),
  ceilingRules: z.array(z.object({ when: z.enum(['missing-evidence', 'unsettled-effect', 'missing-approval']),
    maxScore: scoreSchema,
  }).strict().readonly()).max(3).readonly(),
  decisionThresholds: z.object({ rejectBelow: scoreSchema, acceptAt: scoreSchema }).strict().readonly(),
}).strict().refine(value => unique(value.criterionTypes) && unique(value.evidenceTypes)
  && unique(value.rubric.map(row => row.criterionType)) && unique(value.ceilingRules.map(row => row.when))
  && value.criterionTypes.every(kind => value.rubric.some(row => row.criterionType === kind))
  && value.rubric.every(row => value.criterionTypes.includes(row.criterionType) && unique(row.evidenceTypes)
    && row.evidenceTypes.every(kind => value.evidenceTypes.includes(kind)))
  && value.evidenceTypes.every(kind => value.rubric.some(row => row.evidenceTypes.includes(kind)))
  && value.decisionThresholds.rejectBelow <= value.decisionThresholds.acceptAt).readonly();
const classSchema = z.object({ id: identitySchema, defaultEffort: z.enum(REASONING_EFFORTS) }).strict().readonly();
/** Trusted registry policy only; absence never means standing admission. No parent inherits this grant. */
const proposalAdmission = z.object({ risk: z.enum(['low', 'normal', 'high']), standingAdmission: z.boolean() }).strict()
  .refine(value => !value.standingAdmission || value.risk === 'low').readonly();
const proposalPermissions = z.array(z.object({ kind: identitySchema, actions: z.array(identitySchema).min(1).max(256).readonly() }).strict().readonly()).max(256).readonly();
const bindingSchema = z.object({ kind: identitySchema, classId: identitySchema }).strict().readonly();
const legacyRegistrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema,
  classes: z.array(classSchema).min(1).max(256).readonly(),
  bindings: z.array(bindingSchema).max(1024).readonly(),
}).strict();
const currentClassShape = { id: identitySchema, defaultEffort: z.enum(REASONING_EFFORTS),
  parentClassId: identitySchema.optional(), acceptanceProfile: workClassAcceptanceProfileSchema, proposalAdmission: proposalAdmission.optional(),
  /** R3 (owner D4a): this class's silence policy, over the installation default; admission refuses it unless it stops before the deadline. */
  inactivity: z.object({ warnAfterMs: z.number().int().positive().safe(), stopAfterMs: z.number().int().positive().safe() }).strict()
    .refine(value => value.warnAfterMs < value.stopAfterMs).readonly().optional() };
const currentBindingsSchema = z.array(z.object({ kind: identitySchema, classId: identitySchema,
  override: z.object({ previousClassId: identitySchema }).strict().readonly().optional(),
}).strict().readonly()).max(1024).readonly();
const currentRegistrySchema = z.object({ schemaVersion: z.literal(2), revision: identitySchema,
  classes: z.array(z.object(currentClassShape).strict().readonly()).min(1).max(256).readonly(),
  bindings: currentBindingsSchema,
  proposalPermissions: proposalPermissions.optional(),
}).strict();
export const evidenceExtensionSchema = z.object({ id: z.string().regex(/^ext:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  version: z.number().int().positive().safe(), mapsTo: coreEvidenceTypeSchema,
  label: z.object({ en: identitySchema, tr: identitySchema }).strict().readonly(),
}).strict().readonly();
const extendedRegistrySchema = currentRegistrySchema.extend({ schemaVersion: z.literal(3),
  evidenceExtensions: z.array(evidenceExtensionSchema).max(256).readonly(),
});
/** ATAMA-1 (owner ASS1, A1, A5): one ordered (channel, exact model, optional effort deviation) list. Admission takes the first candidate the
 * scope may use and seals the choice; nothing outside the list is ever chosen. `effort` is the class's deviation from the catalog's vendor
 * default; absent = the vendor default (or the CLI's own default when the catalog declares none). An overlay replaces a Core list only by a
 * compare-and-set against its version, never implicitly. */
const exactCandidateSchema = z.object({ channelId: identitySchema, modelId: exactModelIdSchema, effort: z.enum(REASONING_EFFORTS).optional() }).strict().readonly();
const tierRank = (tier: typeof MODEL_TIERS[number]) => MODEL_TIERS.indexOf(tier);
const selectorList = (max: number) => z.array(identitySchema).min(1).max(max).readonly().refine(unique);
/** M3 (MODEL-INDEPENDENCE-AUDIT, owner 2026-10-23 "model bağımsız"): a candidate SELECTOR names no model. Assignment expands it, in the tier/role
 * registry's order, to the exact catalog models that hold `role` (S2 `model_roles`, the only tier/role owner), pass the optional tier, maker
 * (canonical, via the maker registry) and channel filters, are in the scope's catalog and active there; each expanded model then goes through
 * the same admission check as an exact candidate and the seal records the concrete id plus the expansion digest. A model that is new data
 * (catalog row + role row + activation) thus joins a list with no list or code edit. A maker filter never matches an unknown maker. */
export const candidateSelectorSchema = z.object({ role: identitySchema, minTier: z.enum(MODEL_TIERS).optional(), maxTier: z.enum(MODEL_TIERS).optional(),
  makerIn: selectorList(limits.selectorMakers).optional(), makerNotIn: selectorList(limits.selectorMakers).optional(),
  channelIn: selectorList(limits.selectorChannels).optional(), effort: z.enum(REASONING_EFFORTS).optional(),
}).strict().refine(value => (value.makerIn === undefined || value.makerNotIn === undefined)
  && (value.minTier === undefined || value.maxTier === undefined || tierRank(value.minTier) <= tierRank(value.maxTier))).readonly();
export type CandidateSelector = z.infer<typeof candidateSelectorSchema>;
export type ExactCandidate = z.infer<typeof exactCandidateSchema>;
export const isCandidateSelector = (entry: ExactCandidate | CandidateSelector): entry is CandidateSelector => 'role' in entry;
const candidateKey = (entry: ExactCandidate | CandidateSelector) => isCandidateSelector(entry) ? JSON.stringify(entry) : JSON.stringify([entry.channelId, entry.modelId]);
const policyShape = <T extends z.ZodTypeAny>(candidate: T) => z.object({ id: identitySchema, version: z.number().int().positive().safe(),
  candidates: z.array(candidate).min(1).max(limits.candidatesPerPolicy).readonly(),
  override: z.object({ previousVersion: z.number().int().positive().safe() }).strict().readonly().optional(),
}).strict().refine(value => unique((value.candidates as readonly (ExactCandidate | CandidateSelector)[]).map(candidateKey))
  && (value.override === undefined || value.override.previousVersion < value.version)).readonly();
/** Registry v4 lists: exact candidates only (kept readable unchanged). */
const exactCandidatePolicySchema = policyShape(exactCandidateSchema);
/** Registry v5 lists (M3): exact candidates and selectors, in one declared order. */
export const candidatePolicySchema = policyShape(z.union([exactCandidateSchema, candidateSelectorSchema]));
export type CandidatePolicy = z.infer<typeof candidatePolicySchema>;
/** The tier/role registry role a system-assigned worker must hold, exact candidates included (M3 closes the list-only bypass); registry data. */
export const WORK_CLASS_WORKER_ROLE: string = identitySchema.parse(assignmentData.workerRole);
/** Bounds of candidate lists and their selector expansion (`work-class-limits.json`). */
export const WORK_CLASS_LIMITS = Object.freeze({ ...limits });
const assignedRegistrySchema = extendedRegistrySchema.extend({ schemaVersion: z.literal(4),
  classes: z.array(z.object({ ...currentClassShape, candidatePolicyId: identitySchema.optional() }).strict().readonly()).min(1).max(256).readonly(),
  candidatePolicies: z.array(exactCandidatePolicySchema).max(limits.candidatePolicies).readonly(),
});
const selectorRegistrySchema = assignedRegistrySchema.extend({ schemaVersion: z.literal(5),
  candidatePolicies: z.array(candidatePolicySchema).max(limits.candidatePolicies).readonly(),
});
/** V1 is an immutable historical complete policy. V2 may refer to Core parents/bindings; resolution validates the complete graph. */
export const workClassRegistrySchema = z.discriminatedUnion('schemaVersion', [legacyRegistrySchema, currentRegistrySchema, extendedRegistrySchema, assignedRegistrySchema, selectorRegistrySchema])
  .refine(value => unique(value.classes.map(row => row.id)) && unique(value.bindings.map(row => row.kind))
    && (value.schemaVersion !== 1 || value.bindings.every(row => value.classes.some(entry => entry.id === row.classId)))
    && (value.schemaVersion < 3 || ('evidenceExtensions' in value && unique(value.evidenceExtensions.map(row => row.id))))
    && (value.schemaVersion < 4 || ('candidatePolicies' in value && unique(value.candidatePolicies.map(row => row.id))))
    && (value.schemaVersion >= 3 || value.schemaVersion === 1 || value.classes.every(row => row.acceptanceProfile.evidenceTypes.every(type => !type.startsWith('ext:'))))).readonly();
export type WorkClassRegistry = z.infer<typeof workClassRegistrySchema>;
export type WorkClassAcceptanceProfile = z.infer<typeof workClassAcceptanceProfileSchema>;
/** Compatibility seed until the lead admits canonical business-neutral Core identities. */
export const CORE_WORK_CLASSES: WorkClassRegistry = workClassRegistrySchema.parse(asset);
export class WorkerEffortError extends Error {
  constructor(readonly code: 'WORKER_EFFORT_UNSUPPORTED' | 'WORK_CLASS_NOT_REGISTERED' = 'WORKER_EFFORT_UNSUPPORTED') {
    super(code); this.name = 'WorkerEffortError';
  }
}
export class WorkClassRegistryError extends Error {
  constructor(readonly code: 'WORK_CLASS_OVERRIDE_DENIED' | 'WORK_CLASS_PARENT_INVALID' | 'WORK_CLASS_REGISTRY_LIMIT'
    | 'WORK_CLASS_REVISION_INVALID' | 'WORK_CLASS_EVIDENCE_NOT_REGISTERED' | 'TASK_EVALUATION_PROFILE_MISMATCH' | 'WORK_CLASS_CANDIDATES_NOT_REGISTERED') { super(code); this.name = 'WorkClassRegistryError'; }
}
export type WorkClassPolicy = Readonly<{ revision: string; classes: readonly WorkClassRegistry['classes'][number][];
  bindings: readonly Readonly<{ kind: string; classId: string }>[]; evidenceExtensions?: readonly z.infer<typeof evidenceExtensionSchema>[];
  proposalPermissions?: z.infer<typeof proposalPermissions> | undefined; candidatePolicies?: readonly CandidatePolicy[] }>;
/** Caller order is explicit precedence; revisions are an unambiguous ordered tuple, bounded by the existing wire identifier budget.
 * Class definitions never override. A binding override is a compare-and-set against its prior class, not an implicit permission. */
export function mergeWorkClassRegistries(coreInput: WorkClassRegistry, overlayInputs: readonly WorkClassRegistry[]): WorkClassPolicy {
  const core = workClassRegistrySchema.parse(coreInput), overlays = overlayInputs.map(input => workClassRegistrySchema.parse(input));
  if (overlays.length > 256) throw new WorkClassRegistryError('WORK_CLASS_REGISTRY_LIMIT');
  const extensions = new Map(('evidenceExtensions' in core ? core.evidenceExtensions : []).map(row => [row.id, row]));
  const classes = new Map(core.classes.map(row => [row.id, row]));
  const bindings = new Map(core.bindings.map(row => [row.kind, row.classId]));
  const policies = new Map<string, CandidatePolicy>(('candidatePolicies' in core ? core.candidatePolicies : []).map(row => [row.id, row]));
  if ([...policies.values()].some(row => row.override !== undefined)) throw new WorkClassRegistryError('WORK_CLASS_OVERRIDE_DENIED');
  const permissions = [core, ...overlays].flatMap(row => row.schemaVersion === 1 ? [] : row.proposalPermissions ?? []);
  for (const overlay of overlays) {
    for (const row of 'evidenceExtensions' in overlay ? overlay.evidenceExtensions : []) {
      if (extensions.has(row.id)) throw new WorkClassRegistryError('WORK_CLASS_OVERRIDE_DENIED');
      extensions.set(row.id, row);
    }
    for (const row of 'candidatePolicies' in overlay ? overlay.candidatePolicies : []) {
      // A candidate list is replaced only by a compare-and-set against the version it replaces; a new id never claims an override.
      const previous = policies.get(row.id);
      if (previous ? row.override?.previousVersion !== previous.version : row.override !== undefined) throw new WorkClassRegistryError('WORK_CLASS_OVERRIDE_DENIED');
      policies.set(row.id, row);
    }
    for (const row of overlay.classes) {
      if (classes.has(row.id)) throw new WorkClassRegistryError('WORK_CLASS_OVERRIDE_DENIED');
      classes.set(row.id, row);
    }
    for (const row of overlay.bindings) {
      const previous = bindings.get(row.kind);
      const override = 'override' in row ? row.override : undefined;
      if ((previous !== undefined && previous !== row.classId && override?.previousClassId !== previous)
        || (override !== undefined && (previous === undefined || override.previousClassId !== previous))) {
        throw new WorkClassRegistryError('WORK_CLASS_OVERRIDE_DENIED');
      }
      bindings.set(row.kind, row.classId);
    }
  }
  if (classes.size > 256 || bindings.size > 1024 || extensions.size > 256) throw new WorkClassRegistryError('WORK_CLASS_REGISTRY_LIMIT');
  if (policies.size > limits.candidatePolicies) throw new WorkClassRegistryError('WORK_CLASS_REGISTRY_LIMIT');
  for (const row of classes.values()) if ('candidatePolicyId' in row && row.candidatePolicyId !== undefined && !policies.has(row.candidatePolicyId)) throw new WorkClassRegistryError('WORK_CLASS_CANDIDATES_NOT_REGISTERED');
  for (const classId of bindings.values()) if (!classes.has(classId)) throw new WorkerEffortError('WORK_CLASS_NOT_REGISTERED');
  for (const row of classes.values()) {
    if ('acceptanceProfile' in row && row.acceptanceProfile.evidenceTypes.some(type => type.startsWith('ext:') && !extensions.has(type))) {
      throw new WorkClassRegistryError('WORK_CLASS_EVIDENCE_NOT_REGISTERED');
    }
    const seen = new Set([row.id]); let current = row;
    while ('parentClassId' in current && current.parentClassId !== undefined) {
      const parent = classes.get(current.parentClassId);
      if (!parent || seen.has(parent.id)) throw new WorkClassRegistryError('WORK_CLASS_PARENT_INVALID');
      seen.add(parent.id); current = parent;
    }
  }
  const revision = overlays.length === 0 ? core.revision : JSON.stringify([core.revision, ...overlays.map(row => row.revision)]);
  if (!identitySchema.safeParse(revision).success) throw new WorkClassRegistryError('WORK_CLASS_REVISION_INVALID');
  return Object.freeze({ revision, proposalPermissions: Object.freeze(permissions), evidenceExtensions: Object.freeze([...extensions.values()]), classes: Object.freeze([...classes.values()]),
    candidatePolicies: Object.freeze([...policies.values()]),
    bindings: Object.freeze([...bindings].map(([kind, classId]) => Object.freeze({ kind, classId }))) });
}
/** One effective policy/class owner shared by effort selection and acceptance admission. */
export function resolveTaskWorkClass(kind: string, requested?: string, configured?: WorkClassRegistry) {
  const policy: WorkClassPolicy = configured?.schemaVersion !== undefined && configured.schemaVersion !== 1
    ? mergeWorkClassRegistries(CORE_WORK_CLASSES, [configured]) : configured ?? CORE_WORK_CLASSES;
  const classId = requested ?? policy.bindings.find(row => row.kind === kind)?.classId;
  const workClass = policy.classes.find(row => row.id === classId);
  if (requested !== undefined && !workClass) throw new WorkerEffortError('WORK_CLASS_NOT_REGISTERED');
  return { policy, workClass };
}
/** ATAMA-1: the class's declared candidate list in the effective policy, or null when the class declares none (no default list exists). */
export function resolveWorkClassCandidates(policy: WorkClassPolicy, workClass: WorkClassPolicy['classes'][number] | undefined): CandidatePolicy | null {
  const id = workClass && 'candidatePolicyId' in workClass ? workClass.candidatePolicyId : undefined;
  if (id === undefined) return null;
  const found = policy.candidatePolicies?.find(row => row.id === id);
  if (!found) throw new WorkClassRegistryError('WORK_CLASS_CANDIDATES_NOT_REGISTERED');
  return found;
}
/** A1: the catalog's vendor default reasoning level for a model, or null when the catalog declares none (the CLI's own default then applies). */
export const catalogDefaultEffort = (model: CatalogModel): ReasoningEffort | null => 'reasoning' in model && model.reasoning ? model.reasoning.defaultEffort : null;
/** Pure deterministic selection, clamped down to the closest declared level, or the lowest non-Ultra level when all exceed the target.
 * Ultra requires an explicit request or an Ultra registry target; otherwise leave the CLI setting absent with a visible status.
 * No text inference, model switching or provider id branch; capability is supplied by the command registry. */
export function selectWorkerEffort(input: Readonly<{ model: CatalogModel; capability: Readonly<{ mode: 'arguments' | 'model-id'; levels: readonly string[] }> | null;
  explicit?: ReasoningEffort | undefined; kind: string; workClass?: string | undefined; policy?: WorkClassRegistry | undefined;
  /** ATAMA-1 system assignment: the target is the chosen candidate's deviation or the catalog's vendor default (A1), never the class default;
   * null leaves the CLI default in place. Absent = the pinned-model path, which keeps the class default target. */
  assigned?: Readonly<{ target: ReasoningEffort | null }> | undefined }>): WorkerEffort {
  const { model, capability, explicit } = input;
  // An explicit supported effort does not consume the requested class; acceptance admission still validates it independently.
  const { policy, workClass } = resolveTaskWorkClass(input.kind, explicit === undefined ? input.workClass : undefined, input.policy);
  const supported = capability === null ? [] : REASONING_EFFORTS.filter(level => model.efforts.includes(level) && capability.levels.includes(level)
    && (capability.mode !== 'model-id' || model.effortBinding?.level === level));
  if (explicit !== undefined && !supported.includes(explicit)) throw new WorkerEffortError();
  if (explicit !== undefined) return workerEffortSchema.parse({ schemaVersion: 1, level: explicit, source: 'explicit', status: 'selected' });
  if (input.workClass !== undefined && !workClass) throw new WorkerEffortError('WORK_CLASS_NOT_REGISTERED');
  if (supported.length === 0) return workerEffortSchema.parse({ schemaVersion: 1, level: null, source: 'cli-default', status: 'unsupported' });
  const assignedTarget = input.assigned?.target;
  if (!workClass || assignedTarget === null) {
    if (capability?.mode === 'model-id' && model.effortBinding!.level === 'ultra') return workerEffortSchema.parse({ schemaVersion: 1, level: null, source: 'cli-default', status: 'ultra-opt-in-required' });
    return workerEffortSchema.parse({ schemaVersion: 1, level: capability?.mode === 'model-id' ? model.effortBinding!.level : null,
      source: 'cli-default', status: capability?.mode === 'model-id' ? 'selected' : 'cli-default' });
  }
  const target = assignedTarget ?? workClass.defaultEffort;
  const lower = supported.filter(level => REASONING_EFFORTS.indexOf(level) <= REASONING_EFFORTS.indexOf(target));
  const level = lower.at(-1) ?? supported[0]!;
  if (level === 'ultra' && target !== 'ultra') return workerEffortSchema.parse({ schemaVersion: 1, level: null, source: 'cli-default',
    status: 'ultra-opt-in-required', workClass: workClass.id, policyRevision: policy.revision, target });
  return workerEffortSchema.parse({ schemaVersion: 1, level, source: 'policy-default', status: 'selected',
    workClass: workClass.id, policyRevision: policy.revision, target });
}
