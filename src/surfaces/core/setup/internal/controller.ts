import { t, type Locale } from '#platform/index.js';
import { WORK_KIND_STAGE_ID, WORK_PROVIDERS, type SetupObservation, type SetupPlan, type SetupStage, type SetupStageRegistry } from '#engine/index.js';
import type { SetupWindowModel } from '#surfaces/core/project-instructions/index.js';
import { firstJobCommand, firstJobSteps, firstJobTitle, type FirstJobFacts } from '#surfaces/core/doctor/index.js';
import { notWiredApply, type SetupApplyResult, type SetupCommandContext } from './contract.js';
import { planFor, unattendedAnswers, type SetupFlags } from './command.js';
import { observeSetup } from './observe.js';
import { isForegroundStage, runForegroundStage } from './foreground.js';
import { languageName, setupScope, stageCommand, stageText, stageTitle, stateLabel } from './render.js';
import registry from './modes.json' with { type: 'json' };

type Observed = Readonly<{ observation: SetupObservation; registry: SetupStageRegistry; firstJob?: FirstJobFacts }>;
type Choice = Readonly<{ id: string; label: string; answer?: unknown; action: 'answer' | 'apply' | 'later' | 'close' }>;

/** The stage the person works on now: the first one waiting for an answer or ready to apply that was not put off in this session. */
export const activeStage = (plan: SetupPlan, later: ReadonlySet<string>) =>
  plan.stages.find(stage => !later.has(stage.id) && (stage.state === 'needs-answer' || (stage.state === 'ready' && stage.operation !== null))) ?? null;

/** The answers offered for one stage, at most `windowOptionRows`. Nothing is preselected (the window starts with no highlighted answer). */
export function stageChoices(stage: SetupStage | null, observation: SetupObservation, locale: Locale): readonly Choice[] {
  const later: Choice = { id: 'later', label: t('setup.window.later', {}, locale), action: 'later' };
  if (!stage) return [{ id: 'close', label: t('setup.window.close', {}, locale), action: 'close' }];
  if (stage.state === 'ready') return [{ id: 'apply', label: t('setup.window.apply', {}, locale), action: 'apply' }, later];
  // A model is connected by `models connect` itself (its own connection and model picker), so the window offers to start it.
  if (stage.id === 'core:model') return [{ id: 'connect', label: t('setup.window.connect', {}, locale), action: 'apply' }, later];
  // BR1 1b: the first work kind's coding CLI, from the native CLI registry (the card shows the kind, pool and slots before anything is written).
  if (stage.id === WORK_KIND_STAGE_ID) return [...WORK_PROVIDERS.slice(0, registry.windowOptionRows - 1).map((id): Choice => ({ id, label: id, answer: id, action: 'answer' })), later];
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

/** The stage an apply runs: its own operation, or for the model stage the `models connect` flow in the installation's scope. */
const applied = (stage: SetupStage, scopeId: string | null): SetupStage | null => stage.operation ? stage
  : stage.id === 'core:model' && scopeId ? { ...stage, operation: { id: 'model.connect', version: 1, input: { scopeId } } } : null;
const errorCode = (error: unknown) => { const value = (error as { code?: unknown } | null)?.code; return typeof value === 'string' ? value : 'SETUP_STAGE_FAILED'; };

/**
 * The guided window's loop without Ink (I-S4): answer → re-plan (pure); apply → the apply port (I-S3) → a fresh observation. A stage whose
 * owner takes the terminal itself (Docker's sudo prompt, the bridge window, `models connect`, the upgrade card, the human doctor) is never
 * run inside the window: `step` closes the window with that stage pending, the command runs `runPending` on the plain terminal, then reopens
 * the window. "Not now", a refusal, or an apply after which the stage is still open put the stage off for this window (never re-offered in a
 * loop). Every model has the same number of rows, so the window never changes height.
 */
export function createSetupController(input: Readonly<{ context: SetupCommandContext; root: string; locale: Locale; observed: Observed; flags: SetupFlags }>) {
  const { context, root, locale, flags } = input, later = new Set<string>(), results: SetupApplyResult[] = [];
  let observed = input.observed, values = unattendedAnswers(observed.observation, flags, true), note = '', pending: SetupStage | null = null;
  const plan = () => planFor(observed, values);
  const scopeId = () => typeof values['core:folder'] === 'string' ? values['core:folder'] : observed.observation.folder.configuredScope ?? null;
  const model = (): SetupWindowModel => {
    const current = plan(), stage = activeStage(current, later), at = stage ? current.stages.indexOf(stage) : -1;
    // Nothing left to answer: the same rows name the first step the first job still needs (I-S7), or that it is ready; the height never changes.
    const first = !stage && observed.firstJob ? firstJobSteps(observed.firstJob, setupScope(current))[0] ?? null : null;
    const next = !stage && observed.firstJob ? first ? t('setup.firstJob.window', { step: firstJobTitle(first, locale) }, locale) : t('doctor.firstJob.ready', {}, locale) : '';
    const rows = [...current.stages.map((item, index) => `${index === at ? '>' : ' '} ${index + 1}. ${stageTitle(item, locale)} · ${stateLabel(item.state, locale)}`), '',
      stage ? stageText(current, stage.reason.code, stage.reason.params, locale) : t('setup.window.finished', {}, locale),
      stage?.question ? stageText(current, stage.question.key, stage.question.params, locale) : next,
      note || (stage && stageCommand(stage) ? `$ ${stageCommand(stage)}` : first ? `$ ${firstJobCommand(first)}` : '')];
    return { title: t('setup.window.title', {}, locale), rows, options: stageChoices(stage, observed.observation, locale).map(({ id, label }) => ({ id, label })),
      optionRows: registry.windowOptionRows, hints: t('setup.window.hints', {}, locale), position: t('setup.window.position', {}, locale), reveal: Math.max(0, at) };
  };
  /** After an apply: the next state comes only from a fresh observation; a stage still open afterwards is put off (bounded, no loop). */
  const settle = async (stage: SetupStage, result: SetupApplyResult) => {
    results.push(result);
    const title = stageTitle(stage, locale);
    note = result.status === 'applied' ? t('setup.apply.applied', { stage: title }, locale) : result.status === 'not-wired'
      ? t('setup.apply.notWired', { stage: title }, locale) : t('setup.apply.refused', { stage: title, code: result.code ?? '-' }, locale);
    if (result.status === 'applied') observed = await observeSetup(context, root, flags.lang, true);
    if (result.status !== 'applied' || activeStage(plan(), later)?.id === stage.id) later.add(stage.id);
  };
  const step = async (id: string): Promise<SetupWindowModel | null> => {
    const stage = activeStage(plan(), later), picked = stageChoices(stage, observed.observation, locale).find(choice => choice.id === id);
    if (!picked || picked.action === 'close' || !stage) return null;
    note = '';
    if (picked.action === 'later') later.add(stage.id);
    else if (picked.action === 'answer') values = { ...values, [stage.id]: picked.answer };
    else {
      const target = applied(stage, scopeId());
      if (!target) { later.add(stage.id); return model(); }
      // The owner needs the plain terminal: close the window; the command runs it and reopens the window.
      if (isForegroundStage(target)) { pending = target; return null; }
      const options = { env: context.env ?? process.env, ...(scopeId() ? { scopeId: scopeId()! } : {}) };
      await settle(stage, await (context.applySetupStage ?? notWiredApply)(root, target, options)
        .catch((error: unknown): SetupApplyResult => ({ stage: stage.id, operation: target.operation!.id, status: 'refused', code: errorCode(error) })));
    }
    return model();
  };
  /** Runs the stage `step` closed the window for, on the plain terminal; false when nothing is pending (the person closed the window). */
  const runPending = async (): Promise<boolean> => {
    const stage = pending;
    pending = null;
    if (!stage) return false;
    await settle(stage, await runForegroundStage(context, root, stage, scopeId(), locale));
    return true;
  };
  return { model, step, runPending, outcome: () => ({ plan: plan(), results: [...results], ...(observed.firstJob ? { firstJob: observed.firstJob } : {}) }) };
}
