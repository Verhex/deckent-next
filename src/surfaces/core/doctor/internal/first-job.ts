import { nativeCliIds } from '#domain/index.js';
import { MESSAGE_REGISTRY, t, terminalSafeText, type Locale, type MessageKey } from '#platform/index.js';
import registry from './first-job.json' with { type: 'json' };

/** What settles each first-job step, read from configuration and the pool ledger only (I-S7): an execution section names a worker image,
 * an admission registry is authored, the pool's ledger row exists. Image presence on the host is not read here: the registry preview checks
 * it, and that preview starts a container, so it never runs from an observation, a pipe, `--json` or `--yes`. */
export type FirstJobFacts = Readonly<{ execution: boolean; registry: boolean; pool: boolean }>;
export type FirstJobStep = Readonly<{ id: string; title: MessageKey; argv: readonly string[] }>;
type Fact = keyof FirstJobFacts;

/** The pool readiness statuses that mean the ledger row exists (drift is reported by doctor's own pool row). */
export const poolProvisioned = (status: string) => status === 'ready' || status === 'drift';

/** The missing first-job steps in registry order, each with its exact command (the scope filled in, the providers from the native CLI
 * registry); empty when the installation is ready for the first job. Pure: the same facts give the same list. */
export function firstJobSteps(facts: FirstJobFacts, scopeId: string | null): readonly FirstJobStep[] {
  const fill = (part: string) => part === '{scope}' ? scopeId ?? '<scope>' : part === '{providers}' ? `<${nativeCliIds.join('|')}>` : part;
  return registry.steps.filter(step => !facts[step.fact as Fact])
    .map(step => Object.freeze({ id: step.id, title: step.title as MessageKey, argv: Object.freeze(step.command.map(fill)) }));
}
/** A step's title in the person's language (registry data names the message key, as the setup plan's stage titles do). */
export const firstJobTitle = (step: FirstJobStep, locale: Locale) => (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[step.title] ?? step.title;
/** The command as a person types it: a JSON argument is single-quoted for the shell, every part made terminal-safe. */
export const firstJobCommand = (step: FirstJobStep) => step.argv.map(part => terminalSafeText(/^[{[]/u.test(part) ? `'${part}'` : part)).join(' ');
/** One line per missing step (title, then the command), or the single ready line. */
export function firstJobLines(steps: readonly FirstJobStep[], locale: Locale): string[] {
  if (!steps.length) return [t('doctor.firstJob.ready', {}, locale)];
  return [t('doctor.firstJob.header', {}, locale), ...steps.flatMap((step, index) => [`${index + 1}. ${firstJobTitle(step, locale)}`, `   $ ${firstJobCommand(step)}`])];
}
