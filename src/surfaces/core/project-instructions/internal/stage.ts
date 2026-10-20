import { setupObservationSchema, type InstructionInitPreview, type SetupDecision, type SetupFamilyPackage, type SetupStageContext } from '#engine/index.js';

/** I-S4: the bridges window as one setup stage (ANALYSIS §4.2 stage 11). Project instructions and host bridges are a family stage, not a
 * Core stage: they write user files for AI coding hosts. Facts come from the existing read-only preview; the write stays with
 * `ProjectInstructionPort.initialize` (its own preview, digest and governed file effect), which the setup apply port calls (I-S3). */
export const PROJECT_INSTRUCTION_STAGE_ID = 'instructions:bridges';
export type ProjectInstructionFacts = Readonly<{ file: 'present' | 'missing'; bridges: readonly Readonly<{ id: string; detected: boolean }>[] }>;
const isFacts = (value: unknown): value is ProjectInstructionFacts => {
  const facts = value as Partial<ProjectInstructionFacts> | null, keys = facts && typeof facts === 'object' ? Object.keys(facts).sort().join(',') : '';
  return keys === 'bridges,file' && (facts!.file === 'present' || facts!.file === 'missing') && Array.isArray(facts!.bridges) && facts!.bridges.length <= 16
    && facts!.bridges.every(row => row && typeof row === 'object' && Object.keys(row).sort().join(',') === 'detected,id' && typeof row.id === 'string'
      && row.id.length > 0 && row.id.length <= 64 && typeof row.detected === 'boolean');
};
// The registry takes a zod schema and this unit is not a zod owner (dependencies registry): the setup contract's own family-facts schema,
// narrowed by the guard above, validates the facts (I-S4; delta/I-S4-dependencies.md names the clean placement for the lead).
const facts = setupObservationSchema.shape.families.removeDefault().refine(isFacts).optional();

export function projectInstructionFacts(preview: InstructionInitPreview): ProjectInstructionFacts {
  // `preview([])` lists a change only for a missing DECKENT.md: no bridge is selected yet.
  return { file: preview.changes.length === 0 ? 'present' : 'missing', bridges: preview.bridges.map(row => ({ id: row.id, detected: row.detected })) };
}

function evaluate(context: SetupStageContext): SetupDecision {
  const observed = context.facts as ProjectInstructionFacts | undefined, policy = context.states.get('core:policy');
  if (!observed) return { state: 'blocked', reason: { code: 'setup.instructions.unavailable', params: {} } };
  const detected = observed.bridges.filter(row => row.detected).length;
  if (observed.file === 'present') return { state: 'done', reason: { code: 'setup.instructions.present', params: { bridges: detected } } };
  // The write is a governed file effect in the installation's scope: it waits for the permissions.
  if (!context.scopeId || (policy !== 'done' && policy !== 'skipped')) return { state: 'blocked', reason: { code: 'setup.instructions.waits', params: {} } };
  if (context.answer === false) return { state: 'skipped', reason: { code: 'setup.instructions.declined', params: {} } };
  const operation = { id: 'project-instructions.initialize', version: 1, input: { scopeId: context.scopeId } };
  return context.answer === true ? { state: 'ready', reason: { code: 'setup.instructions.missing', params: { bridges: detected } }, operation }
    : { state: 'needs-answer', reason: { code: 'setup.instructions.missing', params: { bridges: detected } }, operation,
      question: { key: 'setup.instructions.question', params: {} }, default: false };
}

export const PROJECT_INSTRUCTION_SETUP_FAMILY: SetupFamilyPackage = Object.freeze({ namespace: 'instructions', source: 'deckent-core', facts,
  stages: [{ id: PROJECT_INSTRUCTION_STAGE_ID, after: 'core:model' as const, title: 'setup.instructions.title', evaluate }] });
