import { WORK_SETUP_FAMILY, SetupStageRegistry, type SetupStage, type SetupStageState } from '#engine/index.js';
import { MESSAGE_REGISTRY, t, type Locale, type MessageKey } from '#platform/index.js';

/** Configuration and pool-ledger facts; the work family's own evaluators interpret them. Never run a registry preview here. */
export type FirstJobFacts = Readonly<{ execution: boolean; registry: boolean; pool: boolean }>;
export type FirstJobStep = Pick<SetupStage, 'id' | 'phase' | 'title' | 'state'>;
export const poolProvisioned = (status: string) => status === 'ready' || status === 'drift';

/** Doctor already observes these facts without a setup verdict (which itself calls doctor). Reuse the registered work evaluators;
 * the execution environment has its own doctor row. There is no second first-job list or a recursive setup observation. */
export function firstJobStages(facts: FirstJobFacts, scopeId: string | null): readonly FirstJobStep[] {
  const registry = new SetupStageRegistry([WORK_SETUP_FAMILY]), states = new Map<string, SetupStageState>();
  return registry.list().flatMap(family => family.stages).map(stage => {
    const decision = stage.evaluate({ facts, scopeId, answer: undefined, states });
    states.set(stage.id, decision.state);
    return { id: stage.id, phase: stage.phase, title: stage.title, state: decision.state };
  });
}
/** Missing onboarding stages come from the setup states, including execution stages when supplied by the full planner. */
export function firstJobSteps(stages: readonly FirstJobStep[]): readonly FirstJobStep[] {
  return stages.filter(stage => stage.phase === 'onboarding' && stage.state !== 'done' && stage.state !== 'skipped');
}
export const firstJobTitle = (step: FirstJobStep, locale: Locale) => (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[step.title as MessageKey] ?? step.title;
export const onboardingNext = (step: string, locale: Locale) => t('doctor.firstJob.next', { step }, locale);
