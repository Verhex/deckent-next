import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
import type { TaskDefinition, CriterionDefinition } from '#domain/core/task-graph/index.js';
import { resolveTaskWorkClass, workClassAcceptanceProfileSchema, criterionTypeSchema, evidenceTypeSchema, evidenceExtensionSchema,
  WorkClassRegistryError, type WorkClassRegistry } from './work-class.js';

export const frozenWorkClassProfileSchema = z.object({ workClass: identitySchema, policyRevision: identitySchema,
  profileVersion: counterSchema.positive(), profile: workClassAcceptanceProfileSchema,
  evidenceExtensions: z.array(evidenceExtensionSchema).max(256).readonly(),
}).strict().superRefine((value, ctx) => {
  if (value.profileVersion !== value.profile.version || new Set(value.evidenceExtensions.map(row => row.id)).size !== value.evidenceExtensions.length
    || value.profile.evidenceTypes.some(type => type.startsWith('ext:') && !value.evidenceExtensions.some(row => row.id === type))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'TASK_EVALUATION_PROFILE_MISMATCH' });
  }
}).readonly();
export const acceptanceCriterionSchema = z.object({ criterionId: identitySchema, criterionType: criterionTypeSchema,
  evidenceTypes: z.array(evidenceTypeSchema).min(1).max(256).readonly(),
}).strict().refine(value => new Set(value.evidenceTypes).size === value.evidenceTypes.length).readonly();
export const taskAcceptanceReferenceSchema = z.object({ workClass: identitySchema, policyRevision: identitySchema,
  profileVersion: counterSchema.positive(), criteria: z.array(acceptanceCriterionSchema).min(1).readonly(),
}).strict().refine(value => new Set(value.criteria.map(row => row.criterionId)).size === value.criteria.length).readonly();
export class AcceptanceProfileError extends WorkClassRegistryError {
  constructor() { super('TASK_EVALUATION_PROFILE_MISMATCH'); this.name = 'AcceptanceProfileError'; }
}
export function assertAcceptanceCriteria(reference: z.infer<typeof taskAcceptanceReferenceSchema>, frozen: z.infer<typeof frozenWorkClassProfileSchema>,
  task: TaskDefinition, definitions: readonly CriterionDefinition[]): void {
  const invalid = () => { throw new AcceptanceProfileError(); };
  if (reference.workClass !== frozen.workClass || reference.policyRevision !== frozen.policyRevision || reference.profileVersion !== frozen.profileVersion
    || reference.criteria.length !== task.acceptanceCriteria.length || task.acceptanceCriteria.some(id => !reference.criteria.some(row => row.criterionId === id))) invalid();
  for (const row of reference.criteria) {
    const rubric = frozen.profile.rubric.find(entry => entry.criterionType === row.criterionType);
    const declared = definitions.find(entry => entry.id === row.criterionId)?.acceptance;
    if (!rubric || row.evidenceTypes.some(type => !rubric.evidenceTypes.includes(type))
      || (declared && (declared.criterionType !== row.criterionType || JSON.stringify(declared.evidenceTypes) !== JSON.stringify(row.evidenceTypes)))) invalid();
  }
  if (frozen.profile.criterionTypes.some(type => !reference.criteria.some(row => row.criterionType === type))) invalid();
}
/** Admission is the sole resolver; absent v1 profiles stay absent without a default or backfill. */
export function freezeTaskAcceptance(task: TaskDefinition, definitions: readonly CriterionDefinition[], configured?: WorkClassRegistry) {
  const { policy, workClass } = resolveTaskWorkClass(task.kind, task.workInput?.workClass, configured);
  if (!workClass || !('acceptanceProfile' in workClass)) return undefined;
  const frozen = frozenWorkClassProfileSchema.parse({ workClass: workClass.id, policyRevision: policy.revision,
    profileVersion: workClass.acceptanceProfile.version, profile: workClass.acceptanceProfile,
    evidenceExtensions: (policy.evidenceExtensions ?? []).filter(row => workClass.acceptanceProfile.evidenceTypes.includes(row.id)) });
  const reference = taskAcceptanceReferenceSchema.parse({ workClass: frozen.workClass, policyRevision: frozen.policyRevision,
    profileVersion: frozen.profileVersion, criteria: task.acceptanceCriteria.map(criterionId => {
      const declared = definitions.find(row => row.id === criterionId)?.acceptance;
      const single = frozen.profile.rubric.length === 1 ? frozen.profile.rubric[0] : undefined;
      if (!declared && !single) throw new AcceptanceProfileError();
      return { criterionId, criterionType: (declared ?? single)!.criterionType, evidenceTypes: (declared ?? single)!.evidenceTypes };
    }) });
  assertAcceptanceCriteria(reference, frozen, task, definitions);
  return { frozen, reference };
}
export type FrozenWorkClassProfile = z.infer<typeof frozenWorkClassProfileSchema>;
export type TaskAcceptanceReference = z.infer<typeof taskAcceptanceReferenceSchema>;
