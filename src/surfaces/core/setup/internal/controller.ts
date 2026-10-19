import { t, type Locale } from '#platform/index.js';
import type { SetupObservation, SetupPlan, SetupStage, SetupStageRegistry } from '#engine/index.js';
import type { SetupWindowModel } from '#surfaces/core/project-instructions/index.js';
import { notWiredApply, type SetupApplyResult, type SetupCommandContext } from './contract.js';
import { planFor, unattendedAnswers, type SetupFlags } from './command.js';
import { observeSetup } from './observe.js';
import { languageName, stageCommand, stageText, stageTitle, stateLabel } from './render.js';
import registry from './modes.json' with { type: 'json' };

type Observed = Readonly<{ observation: SetupObservation; registry: SetupStageRegistry }>;
type Choice = Readonly<{ id: string; label: string; answer?: unknown; action: 'answer' | 'apply' | 'later' | 'close' }>;

/** The stage the person works on now: the first one waiting for an answer or ready to apply that was not put off in this session. */
export const activeStage = (plan: SetupPlan, later: ReadonlySet<string>) =>
  plan.stages.find(stage => !later.has(stage.id) && (stage.state === 'needs-answer' || (stage.state === 'ready' && stage.operation !== null))) ?? null;

/** The answers offered for one stage, at most `windowOptionRows`. Nothing is preselected (the window starts with no highlighted answer). */
export function stageChoices(stage: SetupStage | null, observation: SetupObservation, locale: Locale): readonly Choice[] {
  const later: Choice = { id: 'later', label: t('setup.window.later', {}, locale), action: 'later' };
  if (!stage) return [{ id: 'close', label: t('setup.window.close', {}, locale), action: 'close' }];
  if (stage.state === 'ready') return [{ id: 'apply', label: t('setup.window.apply', {}, locale), action: 'apply' }, later];
  if (stage.id === 'core:language') return [...['en', 'tr'].map((code): Choice => ({ id: code, label: languageName(code, locale), answer: code, action: 'answer' })), later];
  // The default (solo, INIT-D4) comes first; the other registered profiles follow in registry order.
  if (stage.id === 'core:profile') return [...[...observation.profile.available].sort((a, b) => Number(b.id === 'core:solo') - Number(a.id === 'core:solo'))
    .slice(0, registry.windowOptionRows - 1)
    .map((entry): Choice => ({ id: entry.id, label: entry.id, answer: { id: entry.id, version: entry.version }, action: 'answer' })), later];
  const yes = (answer: unknown): Choice => ({ id: 'yes', label: t('setup.window.yes', {}, locale), answer, action: 'answer' });
  if (stage.id === 'core:folder') return typeof stage.default === 'string' && stage.default ? [yes(stage.default), later] : [later];
  if (typeof stage.default === 'boolean') return [yes(true), { id: 'no', label: t('setup.window.no', {}, locale), answer: false, action: 'answer' }, later];
  return [later];
}

/**
 * The guided window's loop without Ink (I-S4): answer → re-plan (pure); apply → the apply port (I-S3; `not-wired` until then) → a fresh
 * observation. "Not now" puts a stage off for this window only. Every model has the same number of rows, so the window never changes height.
 */
export function createSetupController(input: Readonly<{ context: SetupCommandContext; root: string; locale: Locale; observed: Observed; flags: SetupFlags }>) {
  const { context, root, locale, flags } = input, later = new Set<string>(), results: SetupApplyResult[] = [];
  let observed = input.observed, values = unattendedAnswers(observed.observation, flags, true), note = '';
  const plan = () => planFor(observed, values);
  const model = (): SetupWindowModel => {
    const current = plan(), stage = activeStage(current, later), at = stage ? current.stages.indexOf(stage) : -1;
    const rows = [...current.stages.map((item, index) => `${index === at ? '>' : ' '} ${index + 1}. ${stageTitle(item, locale)} · ${stateLabel(item.state, locale)}`), '',
      stage ? stageText(current, stage.reason.code, stage.reason.params, locale) : t('setup.window.finished', {}, locale),
      stage?.question ? stageText(current, stage.question.key, stage.question.params, locale) : '',
      note || (stage && stageCommand(stage) ? `$ ${stageCommand(stage)}` : '')];
    return { title: t('setup.window.title', {}, locale), rows, options: stageChoices(stage, observed.observation, locale).map(({ id, label }) => ({ id, label })),
      optionRows: registry.windowOptionRows, hints: t('setup.window.hints', {}, locale), position: t('setup.window.position', {}, locale), reveal: Math.max(0, at) };
  };
  const step = async (id: string): Promise<SetupWindowModel | null> => {
    const stage = activeStage(plan(), later), picked = stageChoices(stage, observed.observation, locale).find(choice => choice.id === id);
    if (!picked || picked.action === 'close' || !stage) return null;
    note = '';
    if (picked.action === 'later') later.add(stage.id);
    else if (picked.action === 'answer') values = { ...values, [stage.id]: picked.answer };
    else {
      // The next state comes only from a fresh observation, never from the apply result.
      const result = await (context.applySetupStage ?? notWiredApply)(root, stage, { env: context.env ?? process.env });
      results.push(result);
      const title = stageTitle(stage, locale);
      note = result.status === 'applied' ? t('setup.apply.applied', { stage: title }, locale) : result.status === 'not-wired'
        ? t('setup.apply.notWired', { stage: title }, locale) : t('setup.apply.refused', { stage: title, code: result.code ?? '-' }, locale);
      if (result.status === 'applied') observed = await observeSetup(context, root, flags.lang); else later.add(stage.id);
    }
    return model();
  };
  return { model, step, outcome: () => ({ plan: plan(), results: [...results] }) };
}
