import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { exactModelIdSchema, REASONING_EFFORTS } from '#domain/core/provider-catalog/index.js';
import limits from './work-class-limits.json' with { type: 'json' };
/** Why a declared candidate was not chosen: the typed admission refusal its model would have received (catalog, scope activation,
 * lifecycle, channel/CLI match, CLI floor, effort support) or the tier/role refusal (M3). Bounded identifier; never free text. */
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
const sealShape = { workClass: identitySchema, workClassRevision: identitySchema,
  candidatePolicy: assignmentPolicyReferenceSchema,
  candidateIndex: counterSchema, channelId: identitySchema, modelId: exactModelIdSchema,
  catalogRevision: identitySchema, modelRevision: counterSchema.positive(), activationRevision: counterSchema.positive(),
  effort: z.object({ level: z.enum(REASONING_EFFORTS).nullable(), source: assignmentEffortSourceSchema }).strict().readonly() };
const exactSealSchema = z.object({ schemaVersion: z.literal(1), ...sealShape,
  skipped: z.array(workerAssignmentSkipSchema).max(limits.candidatesPerPolicy).readonly(),
}).strict().refine(value => value.candidateIndex < limits.candidatesPerPolicy && value.skipped.length === value.candidateIndex
  && value.skipped.every((row, index) => row.index === index)).readonly();
/**
 * M3 seal v2: the choice was reached through a candidate SELECTOR (or after one). `candidateIndex` is the declared entry's position in the
 * list; `skipped` is every model tried before the choice, in order, each naming the entry it came from (an exact entry or one selector's
 * expansion, so one entry may skip several models). `selector` is present when the chosen entry is a selector: the tier/role registry
 * revision it read, how many models it expanded to, the chosen model's position in that expansion and the SHA-256 of the canonical
 * expansion (selector, registry revision, ordered exact ids), so the choice is auditable without the live registry. A choice that never
 * met a selector keeps the v1 seal, byte-identical to alpha.54.
 */
const selectorSealSchema = z.object({ schemaVersion: z.literal(2), ...sealShape,
  selector: z.object({ roleRevision: identitySchema, expanded: counterSchema.positive().max(limits.expandedCandidatesPerPolicy), position: counterSchema,
    expansionDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine(value => value.position < value.expanded).readonly().optional(),
  skipped: z.array(workerAssignmentSkipSchema).max(limits.candidatesPerPolicy + limits.expandedCandidatesPerPolicy).readonly(),
}).strict().refine(value => value.candidateIndex < limits.candidatesPerPolicy
  && value.skipped.every((row, index) => row.index <= value.candidateIndex && (index === 0 || value.skipped[index - 1]!.index <= row.index))
  && value.skipped.filter(row => row.index === value.candidateIndex).length === (value.selector?.position ?? 0)).readonly();
/**
 * ATAMA-1 seal (owner ASS1, A1, A5): how the system chose a task's worker when the work input left the model open. Frozen with the Run next to
 * the compiled profile, whose pin stays the execution truth; this record is the audit of the choice: the WorkClass and its policy revision, the
 * candidate list (id, version) and the 0-based index taken, every earlier candidate with the reason it was skipped, and the catalog facts the
 * choice read (model row revision, its catalog revision, the scope's activation revision). `effort.source`: where the requested level came
 * from — the candidate's deviation, the catalog's vendor default, or none (the CLI's own default).
 */
export const workerAssignmentSchema = z.union([exactSealSchema, selectorSealSchema]);
export type WorkerAssignment = z.infer<typeof workerAssignmentSchema>;
export type WorkerAssignmentSkip = z.infer<typeof workerAssignmentSkipSchema>;
