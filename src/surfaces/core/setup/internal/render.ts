import { MESSAGE_REGISTRY, t, terminalSafeText, type Locale } from '#platform/index.js';
import type { SetupPlan, SetupStage, SetupStageState } from '#engine/index.js';
import { profileName } from '#surfaces/core/cli-identity/index.js';
import type { SetupApplyResult } from './contract.js';

/** The versioned `deckent init --json` document (I-S4): locale-free (message keys and their parameters), so an AI or script reads the same
 * contract in every language. `cli` is the exact long command for a stage; `apply` lists what `--yes` tried and how each attempt ended.
 * v2 (alpha.56 U3-1a): each stage names its `phase`; `deckent init` lists the install phase, `--phase onboarding` the first open's stages
 * (what the first job still needs; the v1 `firstJob` list is gone); an apply result may be `declined`. */
export const SETUP_DOCUMENT_SCHEMA_VERSION = 2 as const;
export type SetupDocument = ReturnType<typeof setupDocument>;
export function setupDocument(plan: SetupPlan, apply: Readonly<{ requested: boolean; results: readonly SetupApplyResult[] }>) {
  return { schemaVersion: SETUP_DOCUMENT_SCHEMA_VERSION, planSchemaVersion: plan.schemaVersion, planDigest: plan.planDigest, registryDigest: plan.registryDigest,
    stages: plan.stages.map(stage => ({ id: stage.id, namespace: stage.namespace, phase: stage.phase, state: stage.state, title: stage.title, reason: stage.reason,
      question: stage.question, default: stage.default, cli: stage.cli, operation: stage.operation, autoEligible: stage.autoEligible })),
    authority: setupAuthority(plan),
    apply: { requested: apply.requested, results: apply.results } };
}

/** Derived from the install carrier's observation, never from --yes or an apply exit code. */
export function setupAuthority(plan: SetupPlan) {
  const stage = plan.stages.find(row => row.id === 'permissions:start-mode');
  return { status: !stage ? 'unavailable' as const : stage.state === 'done' ? 'applied' as const : stage.state === 'skipped' ? 'not-applicable' as const : 'authority-pending' as const,
    state: stage?.state ?? null, nextAction: stage && !['done', 'skipped'].includes(stage.state) ? 'setup.permissions.pending' : null };
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
/** An answered stage with no operation waits for installation; it cannot offer Apply yet. */
export const stageStateLabel = (stage: SetupStage, locale: Locale) => stage.state === 'ready' && !stage.operation
  ? t('setup.state.answered', {}, locale) : stateLabel(stage.state, locale);
export const languageName = (code: string, locale: Locale) => LANGUAGE_NAMES[code]?.(locale) ?? terminalSafeText(code);

/** One stage message in the person's words: a `stage` parameter names that stage's title, a `language` parameter the language's name. */
export function stageText(plan: SetupPlan, key: string, params: Readonly<Record<string, string | number>>, locale: Locale): string {
  const shown = Object.fromEntries(Object.entries(params).map(([name, value]) => {
    const stage = name === 'stage' ? plan.stages.find(item => item.id === value) : undefined;
    return [name, stage ? stageTitle(stage, locale) : name === 'language' ? languageName(String(value), locale) : name === 'profile' ? profileName(String(value), locale) : name === 'mode' || name === 'effective' ? terminalSafeText(setupMessage(`terminal.mode.stop.${value}`, {}, locale)) : terminalSafeText(String(value))];
  }));
  return setupMessage(key, shown, locale);
}
/** The installation's scope as the folder stage reports it (configured or answered), else none. */
export const setupScope = (plan: SetupPlan) => { const value = plan.stages.find(stage => stage.id === 'core:folder')?.reason.params['scope']; return typeof value === 'string' && value ? value : null; };
export const stageTitle = (stage: SetupStage, locale: Locale) => setupMessage(stage.title, {}, locale);
export const stageCommand = (stage: SetupStage) => stage.cli ? stage.cli.map(part => terminalSafeText(part)).join(' ') : null;

/** One apply result in the person's words, judged by the fresh plan (never by the apply result alone): "applied" only when the stage is now
 * `done`; a declined card says so; an apply after which the stage is still open reports the state observed again. */
export function applyLine(plan: SetupPlan, result: SetupApplyResult, locale: Locale): string {
  const found = plan.stages.find(item => item.id === result.stage), stage = found ? stageTitle(found, locale) : terminalSafeText(result.stage);
  if (result.status === 'not-wired') return t('setup.apply.notWired', { stage }, locale);
  if (result.status === 'declined') return t('setup.apply.declined', { stage }, locale);
  if (result.status === 'refused') return t('setup.apply.refused', { stage, code: terminalSafeText(result.code ?? '-') }, locale);
  return found?.state === 'done' ? t('setup.apply.applied', { stage }, locale) : t('setup.summary.state', { stage, state: stateLabel(found?.state ?? 'blocked', locale) }, locale);
}

/** Plain lines for a pipe or a dumb terminal (and the summary after the window closes): no colour, no cursor movement, one stage per block. */
export function renderSetupLines(plan: SetupPlan, locale: Locale, apply: Readonly<{ requested: boolean; results: readonly SetupApplyResult[] }>): string {
  const lines = [t('setup.render.header', { digest: plan.planDigest.slice(0, 12) }, locale)];
  plan.stages.forEach((stage, index) => {
    lines.push(`${index + 1}. ${stageTitle(stage, locale)} · ${stageStateLabel(stage, locale)} · ${stageText(plan, stage.reason.code, stage.reason.params, locale)}`);
    if (stage.question && stage.state === 'needs-answer') lines.push(`   ? ${stageText(plan, stage.question.key, stage.question.params, locale)}`);
    const command = stageCommand(stage);
    if (command && stage.state !== 'done') lines.push(`   $ ${command}`);
  });
  for (const result of apply.results) lines.push(applyLine(plan, result, locale));
  if (!apply.results.some(result => result.status === 'applied')) lines.push(apply.requested ? t('setup.render.nothingAppliedYes', {}, locale) : t('setup.render.nothingApplied', {}, locale));
  if (setupAuthority(plan).status === 'authority-pending') lines.push('', t('setup.permissions.pending', {}, locale));
  // The installation is complete once the final check settled; the first open sets up the provider and the first job (onboarding).
  if (plan.stages.some(stage => stage.id === 'core:final-check' && stage.state === 'done')) lines.push('', t('setup.install.done', {}, locale));
  return lines.join('\n');
}
