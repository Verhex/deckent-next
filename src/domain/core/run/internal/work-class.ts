import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { REASONING_EFFORTS, workerEffortSchema, type CatalogModel, type ReasoningEffort, type WorkerEffort } from '#domain/core/provider-catalog/index.js';
import asset from '../../../../../assets/native-coding/work-classes.json' with { type: 'json' };
/** Versioned class/load policy; kind remains the template key. Installation/Enterprise can replace this registry as data. */
export const workClassRegistrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema,
  classes: z.array(z.object({ id: identitySchema, defaultEffort: z.enum(REASONING_EFFORTS) }).strict().readonly()).min(1).max(256).readonly(),
  bindings: z.array(z.object({ kind: identitySchema, classId: identitySchema }).strict().readonly()).max(1024).readonly(),
}).strict().refine(value => new Set(value.classes.map(row => row.id)).size === value.classes.length
  && new Set(value.bindings.map(row => row.kind)).size === value.bindings.length
  && value.bindings.every(row => value.classes.some(entry => entry.id === row.classId))).readonly();
export type WorkClassRegistry = z.infer<typeof workClassRegistrySchema>;
export const CORE_WORK_CLASSES: WorkClassRegistry = workClassRegistrySchema.parse(asset);
export class WorkerEffortError extends Error {
  constructor(readonly code: 'WORKER_EFFORT_UNSUPPORTED' | 'WORK_CLASS_NOT_REGISTERED' = 'WORKER_EFFORT_UNSUPPORTED') { super(code); this.name = 'WorkerEffortError'; }
}
/** Pure deterministic selection, clamped down to the closest declared level, or the lowest non-Ultra level when all exceed the target.
 * Ultra requires an explicit request or an Ultra registry target; otherwise leave the CLI setting absent with a visible status.
 * No text inference, model switching or provider id branch; capability is supplied by the command registry. */
export function selectWorkerEffort(input: Readonly<{ model: CatalogModel; capability: Readonly<{ mode: 'arguments' | 'model-id'; levels: readonly string[] }> | null;
  explicit?: ReasoningEffort | undefined; kind: string; workClass?: string | undefined; policy?: WorkClassRegistry | undefined }>): WorkerEffort {
  const { model, capability, explicit } = input; const policy = input.policy ?? CORE_WORK_CLASSES;
  const classId = input.workClass ?? policy.bindings.find(row => row.kind === input.kind)?.classId;
  const workClass = policy.classes.find(row => row.id === classId);
  const supported = capability === null ? [] : REASONING_EFFORTS.filter(level => model.efforts.includes(level) && capability.levels.includes(level)
    && (capability.mode !== 'model-id' || model.effortBinding?.level === level));
  if (explicit !== undefined && !supported.includes(explicit)) throw new WorkerEffortError();
  if (explicit !== undefined) return workerEffortSchema.parse({ schemaVersion: 1, level: explicit, source: 'explicit', status: 'selected' });
  if (input.workClass !== undefined && !workClass) throw new WorkerEffortError('WORK_CLASS_NOT_REGISTERED');
  if (supported.length === 0) return workerEffortSchema.parse({ schemaVersion: 1, level: null, source: 'cli-default', status: 'unsupported' });
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
