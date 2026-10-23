import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { exactModelIdSchema, REASONING_EFFORTS } from '#domain/core/provider-catalog/index.js';
import limits from './work-class-limits.json' with { type: 'json' };
/** Why a declared candidate was not chosen: the typed admission refusal its model would have received (catalog, scope activation,
 * lifecycle, channel/CLI match, CLI floor, effort support). Bounded identifier; never free text. */
const reasonSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const assignmentPolicyReferenceSchema = z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly();
export const assignmentEffortSourceSchema = z.enum(['candidate', 'catalog', 'cli-default']);
export const workerAssignmentSkipSchema = z.object({ index: counterSchema, channelId: identitySchema, modelId: exactModelIdSchema, reason: reasonSchema }).strict().readonly();
/**
 * ATAMA-1 seal (owner ASS1, A1, A5): how the system chose a task's worker when the work input left the model open. Frozen with the Run next to
 * the compiled profile, whose pin stays the execution truth; this record is the audit of the choice: the WorkClass and its policy revision, the
 * candidate list (id, version) and the 0-based index taken, every earlier candidate with the reason it was skipped, and the catalog facts the
 * choice read (model row revision, its catalog revision, the scope's activation revision). `effort.source`: where the requested level came
 * from — the candidate's deviation, the catalog's vendor default, or none (the CLI's own default).
 */
export const workerAssignmentSchema = z.object({ schemaVersion: z.literal(1),
  workClass: identitySchema, workClassRevision: identitySchema,
  candidatePolicy: assignmentPolicyReferenceSchema,
  candidateIndex: counterSchema, channelId: identitySchema, modelId: exactModelIdSchema,
  catalogRevision: identitySchema, modelRevision: counterSchema.positive(), activationRevision: counterSchema.positive(),
  effort: z.object({ level: z.enum(REASONING_EFFORTS).nullable(), source: assignmentEffortSourceSchema }).strict().readonly(),
  skipped: z.array(workerAssignmentSkipSchema).max(limits.candidatesPerPolicy).readonly(),
}).strict().refine(value => value.candidateIndex < limits.candidatesPerPolicy && value.skipped.length === value.candidateIndex
  && value.skipped.every((row, index) => row.index === index)).readonly();
export type WorkerAssignment = z.infer<typeof workerAssignmentSchema>;
export type WorkerAssignmentSkip = z.infer<typeof workerAssignmentSkipSchema>;
