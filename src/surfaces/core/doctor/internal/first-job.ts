import { WORK_DEFAULTS, WORK_SETUP_FAMILY, SetupStageRegistry, type SetupStage, type SetupStageState } from '#engine/index.js';
import { headlessGovernedUseText, messageText, t, type Locale } from '#platform/index.js';

/** Configuration and pool-ledger facts; the work family's own evaluators interpret them. Never run a registry preview here. */
export type FirstJobFacts = Readonly<{ execution: boolean; registry: boolean; pool: boolean; poolMissing?: boolean; workerReadiness?: import('#domain/index.js').WorkerReadiness | null }>;
export const firstJobKind = WORK_DEFAULTS.kind;
type FirstJobStep = Pick<SetupStage, 'id' | 'phase' | 'title' | 'state'> & Pick<Partial<SetupStage>, 'cli'>;
export const poolProvisioned = (status: string) => status === 'ready' || status === 'drift';

/** Doctor already observes these facts without a setup verdict (which itself calls doctor). Reuse the registered work evaluators;
 * the execution environment has its own doctor row. There is no second first-job list or a recursive setup observation. */
export function firstJobStages(facts: FirstJobFacts, scopeId: string | null): readonly FirstJobStep[] {
  const registry = new SetupStageRegistry([WORK_SETUP_FAMILY]), states = new Map<string, SetupStageState>();
  return registry.list().flatMap(family => family.stages).map(stage => {
    const decision = stage.evaluate({ facts, scopeId, answer: undefined, states });
    states.set(stage.id, decision.state);
    return { id: stage.id, phase: stage.phase, title: stage.title, state: decision.state, ...(decision.cli ? { cli: decision.cli } : {}) };
  });
}
/** Missing onboarding stages come from the setup states, including execution stages when supplied by the full planner. */
export function firstJobSteps(stages: readonly FirstJobStep[]): readonly FirstJobStep[] {
  return stages.filter(stage => stage.phase === 'onboarding' && stage.state !== 'done' && stage.state !== 'skipped');
}
export const firstJobTitle = (step: FirstJobStep, locale: Locale) => messageText(step.title, locale) ?? step.title;
export const onboardingNext = (step: string, locale: Locale) => t('doctor.firstJob.next', { step }, locale);

/** Setup and doctor share the same catalog diagnosis; the typed code remains secondary. */
export function workerReadinessText(code: string, locale: Locale): string {
  if (code === 'HEADLESS_STATE_OUTSIDE_INSTALLATION') return headlessGovernedUseText(locale).text;
  const reason = messageText(`setup.work.workerReason.${code}`, locale, {}) ?? t('setup.work.workerReason.unknown', {}, locale);
  return t('setup.work.workerMissing', { code, reason }, locale);
}

export function workerReadinessNext(worker: NonNullable<FirstJobFacts['workerReadiness']>, locale: Locale): string {
  return worker.code === 'HEADLESS_STATE_OUTSIDE_INSTALLATION'
    ? headlessGovernedUseText(locale, worker.cli.at(-1)).next : worker.cli.join(' ');
}
