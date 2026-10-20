import { MESSAGE_REGISTRY, t, terminalSafeText, type Locale } from '#platform/index.js';
import type { SetupPlan, SetupStage, SetupStageState } from '#engine/index.js';
import { firstJobLines, firstJobSteps, type FirstJobFacts } from '#surfaces/core/doctor/index.js';
import type { SetupApplyResult } from './contract.js';

/** The versioned `deckent init --json` document (I-S4): locale-free (message keys and their parameters), so an AI or script reads the same
 * contract in every language. `cli` is the exact long command for a stage; `apply` lists what `--yes` tried and how each attempt ended. */
export const SETUP_DOCUMENT_SCHEMA_VERSION = 1 as const;
export type SetupDocument = ReturnType<typeof setupDocument>;
export function setupDocument(plan: SetupPlan, apply: Readonly<{ requested: boolean; results: readonly SetupApplyResult[] }>, firstJob?: FirstJobFacts) {
  return { schemaVersion: SETUP_DOCUMENT_SCHEMA_VERSION, planSchemaVersion: plan.schemaVersion, planDigest: plan.planDigest, registryDigest: plan.registryDigest,
    stages: plan.stages.map(stage => ({ id: stage.id, namespace: stage.namespace, state: stage.state, title: stage.title, reason: stage.reason, question: stage.question,
      default: stage.default, cli: stage.cli, operation: stage.operation, autoEligible: stage.autoEligible })),
    apply: { requested: apply.requested, results: apply.results },
    // I-S7 (additive): the steps the first job still needs, in order, with their exact argv ([] = ready); absent when no first-job facts were observed.
    ...(firstJob ? { firstJob: firstJobSteps(firstJob, setupScope(plan)).map(step => ({ id: step.id, title: step.title, cli: step.argv })) } : {}) };
}

/** A message the plan names by key (stage titles, reasons, questions are message keys of the setup contract): read from the shared
 * catalog and filled the same way as every literal message; an unknown key stays visible as itself. */
export function setupMessage(key: string, params: Readonly<Record<string, string | number>>, locale: Locale): string {
  const text = (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[key];
  return text === undefined ? key : text.replace(/\{(\w+)\}/gu, (whole, name: string) => Object.hasOwn(params, name) ? String(params[name]) : whole);
}
const STATE_LABELS: Readonly<Record<SetupStageState, (locale: Locale) => string>> = Object.freeze({ done: l => t('setup.state.done', {}, l),
  ready: l => t('setup.state.ready', {}, l), 'needs-answer': l => t('setup.state.needsAnswer', {}, l), blocked: l => t('setup.state.blocked', {}, l),
  skipped: l => t('setup.state.skipped', {}, l), unsupported: l => t('setup.state.unsupported', {}, l) });
const LANGUAGE_NAMES: Readonly<Record<string, (locale: Locale) => string>> = Object.freeze({ en: l => t('setup.language.en', {}, l), tr: l => t('setup.language.tr', {}, l) });
export const stateLabel = (state: SetupStageState, locale: Locale) => STATE_LABELS[state](locale);
export const languageName = (code: string, locale: Locale) => LANGUAGE_NAMES[code]?.(locale) ?? terminalSafeText(code);

/** One stage message in the person's words: a `stage` parameter names that stage's title, a `language` parameter the language's name. */
export function stageText(plan: SetupPlan, key: string, params: Readonly<Record<string, string | number>>, locale: Locale): string {
  const shown = Object.fromEntries(Object.entries(params).map(([name, value]) => {
    const stage = name === 'stage' ? plan.stages.find(item => item.id === value) : undefined;
    return [name, stage ? stageTitle(stage, locale) : name === 'language' ? languageName(String(value), locale) : terminalSafeText(String(value))];
  }));
  return setupMessage(key, shown, locale);
}
/** The installation's scope as the folder stage reports it (configured or answered), else none. */
export const setupScope = (plan: SetupPlan) => { const value = plan.stages.find(stage => stage.id === 'core:folder')?.reason.params['scope']; return typeof value === 'string' && value ? value : null; };
export const stageTitle = (stage: SetupStage, locale: Locale) => setupMessage(stage.title, {}, locale);
export const stageCommand = (stage: SetupStage) => stage.cli ? stage.cli.map(part => terminalSafeText(part)).join(' ') : null;

/** Plain lines for a pipe or a dumb terminal (and the summary after the window closes): no colour, no cursor movement, one stage per block. */
export function renderSetupLines(plan: SetupPlan, locale: Locale, apply: Readonly<{ requested: boolean; results: readonly SetupApplyResult[] }>, firstJob?: FirstJobFacts): string {
  const lines = [t('setup.render.header', { digest: plan.planDigest.slice(0, 12) }, locale)];
  plan.stages.forEach((stage, index) => {
    lines.push(`${index + 1}. ${stageTitle(stage, locale)} · ${stateLabel(stage.state, locale)} · ${stageText(plan, stage.reason.code, stage.reason.params, locale)}`);
    if (stage.question && stage.state === 'needs-answer') lines.push(`   ? ${stageText(plan, stage.question.key, stage.question.params, locale)}`);
    const command = stageCommand(stage);
    if (command && stage.state !== 'done') lines.push(`   $ ${command}`);
  });
  for (const result of apply.results) lines.push(result.status === 'not-wired' ? t('setup.apply.notWired', { stage: terminalSafeText(result.stage) }, locale)
    : result.status === 'applied' ? t('setup.apply.applied', { stage: terminalSafeText(result.stage) }, locale)
    : t('setup.apply.refused', { stage: terminalSafeText(result.stage), code: terminalSafeText(result.code ?? '-') }, locale));
  if (!apply.results.some(result => result.status === 'applied')) lines.push(apply.requested ? t('setup.render.nothingAppliedYes', {}, locale) : t('setup.render.nothingApplied', {}, locale));
  if (firstJob) lines.push('', ...firstJobLines(firstJobSteps(firstJob, setupScope(plan)), locale));
  return lines.join('\n');
}
