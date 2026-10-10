import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { REASONING_EFFORTS, workerEffortSchema, type CatalogModel, type ReasoningEffort, type WorkerEffort } from '#domain/core/provider-catalog/index.js';
import asset from '../../../../../assets/native-coding/work-classes.json' with { type: 'json' };
/** Closed, business-neutral vocabulary: concrete evaluator/adapter semantics stay in their registries. */
const criterionTypeSchema = z.enum(['completion', 'correctness', 'safety', 'authorization']);
const evidenceTypeSchema = z.enum(['retained-artifact', 'verification-result', 'operation-settlement', 'observed-readback', 'approval-receipt']);
const scoreSchema = z.number().finite().min(0).max(1);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
export const workClassAcceptanceProfileSchema = z.object({ schemaVersion: z.literal(1), version: z.number().int().positive().safe(),
  criterionTypes: z.array(criterionTypeSchema).min(1).max(4).readonly(),
  evidenceTypes: z.array(evidenceTypeSchema).min(1).max(5).readonly(),
  rubric: z.array(z.object({ criterionType: criterionTypeSchema, evidenceTypes: z.array(evidenceTypeSchema).min(1).max(5).readonly(),
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
const bindingSchema = z.object({ kind: identitySchema, classId: identitySchema }).strict().readonly();
const legacyRegistrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema,
  classes: z.array(classSchema).min(1).max(256).readonly(),
  bindings: z.array(bindingSchema).max(1024).readonly(),
}).strict();
const currentRegistrySchema = z.object({ schemaVersion: z.literal(2), revision: identitySchema,
  classes: z.array(z.object({ id: identitySchema, defaultEffort: z.enum(REASONING_EFFORTS),
    parentClassId: identitySchema.optional(), acceptanceProfile: workClassAcceptanceProfileSchema,
  }).strict().readonly()).min(1).max(256).readonly(),
  bindings: z.array(z.object({ kind: identitySchema, classId: identitySchema,
    override: z.object({ previousClassId: identitySchema }).strict().readonly().optional(),
  }).strict().readonly()).max(1024).readonly(),
}).strict();
/** V1 is an immutable historical complete policy. V2 may refer to Core parents/bindings; resolution validates the complete graph. */
export const workClassRegistrySchema = z.discriminatedUnion('schemaVersion', [legacyRegistrySchema, currentRegistrySchema])
  .refine(value => unique(value.classes.map(row => row.id)) && unique(value.bindings.map(row => row.kind))
    && (value.schemaVersion === 2 || value.bindings.every(row => value.classes.some(entry => entry.id === row.classId)))).readonly();
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
    | 'WORK_CLASS_REVISION_INVALID') { super(code); this.name = 'WorkClassRegistryError'; }
}
export type WorkClassPolicy = Readonly<{ revision: string; classes: readonly WorkClassRegistry['classes'][number][];
  bindings: readonly Readonly<{ kind: string; classId: string }>[] }>;
/** Caller order is explicit precedence; revisions are an unambiguous ordered tuple, bounded by the existing wire identifier budget.
 * Class definitions never override. A binding override is a compare-and-set against its prior class, not an implicit permission. */
export function mergeWorkClassRegistries(coreInput: WorkClassRegistry, overlayInputs: readonly WorkClassRegistry[]): WorkClassPolicy {
  const core = workClassRegistrySchema.parse(coreInput), overlays = overlayInputs.map(input => workClassRegistrySchema.parse(input));
  if (overlays.length > 256) throw new WorkClassRegistryError('WORK_CLASS_REGISTRY_LIMIT');
  const classes = new Map(core.classes.map(row => [row.id, row]));
  const bindings = new Map(core.bindings.map(row => [row.kind, row.classId]));
  for (const overlay of overlays) {
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
  if (classes.size > 256 || bindings.size > 1024) throw new WorkClassRegistryError('WORK_CLASS_REGISTRY_LIMIT');
  for (const classId of bindings.values()) if (!classes.has(classId)) throw new WorkerEffortError('WORK_CLASS_NOT_REGISTERED');
  for (const row of classes.values()) {
    const seen = new Set([row.id]); let current = row;
    while ('parentClassId' in current && current.parentClassId !== undefined) {
      const parent = classes.get(current.parentClassId);
      if (!parent || seen.has(parent.id)) throw new WorkClassRegistryError('WORK_CLASS_PARENT_INVALID');
      seen.add(parent.id); current = parent;
    }
  }
  const revision = overlays.length === 0 ? core.revision : JSON.stringify([core.revision, ...overlays.map(row => row.revision)]);
  if (!identitySchema.safeParse(revision).success) throw new WorkClassRegistryError('WORK_CLASS_REVISION_INVALID');
  return Object.freeze({ revision, classes: Object.freeze([...classes.values()]),
    bindings: Object.freeze([...bindings].map(([kind, classId]) => Object.freeze({ kind, classId }))) });
}
/** Pure deterministic selection, clamped down to the closest declared level, or the lowest non-Ultra level when all exceed the target.
 * Ultra requires an explicit request or an Ultra registry target; otherwise leave the CLI setting absent with a visible status.
 * No text inference, model switching or provider id branch; capability is supplied by the command registry. */
export function selectWorkerEffort(input: Readonly<{ model: CatalogModel; capability: Readonly<{ mode: 'arguments' | 'model-id'; levels: readonly string[] }> | null;
  explicit?: ReasoningEffort | undefined; kind: string; workClass?: string | undefined; policy?: WorkClassRegistry | undefined }>): WorkerEffort {
  const { model, capability, explicit } = input; const policy = input.policy?.schemaVersion === 2
    ? mergeWorkClassRegistries(CORE_WORK_CLASSES, [input.policy]) : input.policy ?? CORE_WORK_CLASSES;
  const classId = input.workClass ?? policy.bindings.find(row => row.kind === input.kind)?.classId;
  const workClass = policy.classes.find(row => row.id === classId);
  const supported = capability === null ? [] : REASONING_EFFORTS.filter(level => model.efforts.includes(level) && capability.levels.includes(level)
    && (capability.mode !== 'model-id' || model.effortBinding?.level === level));
  if (explicit !== undefined && !supported.includes(explicit)) throw new WorkerEffortError();
  if (explicit !== undefined) return workerEffortSchema.parse({ schemaVersion: 1, level: explicit, source: 'explicit', status: 'selected' });
  if (input.workClass !== undefined && !workClass) throw new WorkerEffortError('WORK_CLASS_NOT_REGISTERED');
  if (supported.length === 0) return workerEffortSchema.parse({ schemaVersion: 1, level: null, source: 'cli-default', status: 'unsupported' });
  if (!workClass && capability?.mode === 'model-id' && model.effortBinding!.level === 'ultra') return workerEffortSchema.parse({
    schemaVersion: 1, level: null, source: 'cli-default', status: 'ultra-opt-in-required' });
  if (!workClass) return workerEffortSchema.parse({ schemaVersion: 1, level: capability?.mode === 'model-id' ? model.effortBinding!.level : null,
    source: 'cli-default', status: capability?.mode === 'model-id' ? 'selected' : 'cli-default' });
  const target = workClass.defaultEffort;
  const lower = supported.filter(level => REASONING_EFFORTS.indexOf(level) <= REASONING_EFFORTS.indexOf(target));
  const level = lower.at(-1) ?? supported[0]!;
  if (level === 'ultra' && target !== 'ultra') return workerEffortSchema.parse({ schemaVersion: 1, level: null, source: 'cli-default',
    status: 'ultra-opt-in-required', workClass: workClass.id, policyRevision: policy.revision, target });
  return workerEffortSchema.parse({ schemaVersion: 1, level, source: 'policy-default', status: 'selected',
    workClass: workClass.id, policyRevision: policy.revision, target });
}
