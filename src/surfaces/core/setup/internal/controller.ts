import { LOCALES, t, type Locale } from '#platform/index.js';
import { IdentityProfileRegistry, WORK_KIND_STAGE_ID, WORK_PROVIDERS, type IdentityProfileListing, type SetupObservation, type SetupPlan, type SetupStage, SetupStageRegistry } from '#engine/index.js';
import { orderedProfiles, profileLabel } from '#surfaces/core/cli-identity/index.js';
import type { SetupWindowModel } from '#surfaces/core/project-instructions/index.js';
import { type FirstJobFacts } from '#surfaces/core/doctor/index.js';
import { notWiredApply, type SetupApplyResult, type SetupCommandContext } from './contract.js';
import { planFor, unattendedAnswers, type SetupFlags } from './command.js';
import { observeSetup } from './observe.js';
import { isForegroundStage, runForegroundStage } from './foreground.js';
import { applyLine, languageName, stageCommand, stageStateLabel, stageText, stageTitle } from './render.js';
import registry from './modes.json' with { type: 'json' };

type Observed = Readonly<{ observation: SetupObservation; registry: SetupStageRegistry; firstJob?: FirstJobFacts }>;
type Choice = Readonly<{ id: string; label: string; answer?: unknown; action: 'answer' | 'apply' | 'later' | 'close'; role?: 'yes' | 'no' }>;

/** The stage the person works on now: the first one waiting for an answer or ready to apply that was not put off in this session. */
export const activeStage = (plan: SetupPlan, later: ReadonlySet<string>) =>
  plan.stages.find(stage => !later.has(stage.id) && (stage.state === 'needs-answer' || (stage.state === 'ready' && stage.operation !== null))) ?? null;

/** The answers offered for one stage, at most `windowOptionRows`; the window highlights `initialChoice` (owner 2026-10-26: Enter accepts it).
 * A yes/no stage marks its yes and no answers (`role`), so the window shows and takes (y)/(n) (BeUser walk16): "Not now" is the no of a lone
 * Yes/Apply/Connect and stays letterless beside a real No; language, profile and work-kind choices are a true choice with no letters. */
export function stageChoices(stage: SetupStage | null, observation: SetupObservation, locale: Locale, stageRegistry: SetupStageRegistry = new SetupStageRegistry(), profiles: IdentityProfileListing['profiles'] = new IdentityProfileRegistry().list()): readonly Choice[] {
  const later: Choice = { id: 'later', label: t('setup.window.later', {}, locale), action: 'later' }, notNow: Choice = { ...later, role: 'no' };
  if (!stage) return [{ id: 'close', label: t('setup.window.close', {}, locale), action: 'close' }];
  if (stage.id === 'permissions:start-mode' && stage.state === 'ready') return [{ id: 'apply', label: t('setup.permissions.confirm', {}, locale), action: 'apply', role: 'yes' }, notNow];
  if (stage.state === 'ready') return [{ id: 'apply', label: (registry.readOnly.includes(stage.operation?.id ?? '') ? t('setup.window.run', {}, locale) : t('setup.window.apply', {}, locale)), action: 'apply', role: 'yes' }, notNow];
  // A model is connected by `models connect` itself (its own connection and model picker), so the window offers to start it.
  if (stage.id === 'core:model') return [{ id: 'connect', label: t('setup.window.connect', {}, locale), action: 'apply', role: 'yes' }, notNow];
  // BR1 1b: the first work kind's coding CLI, from the native CLI registry (the card shows the kind, pool and slots before anything is written).
  if (stage.id === WORK_KIND_STAGE_ID) return [...WORK_PROVIDERS.slice(0, registry.windowOptionRows - 1).map((id): Choice => ({ id, label: id, answer: id, action: 'answer' })), later];
  // BeUser AYSE-01: each language is offered in its own words ("English", "Türkçe"), so a person who cannot read the current one still finds hers.
  if (stage.id === 'core:language') return [...LOCALES.map((code): Choice => ({ id: code, label: languageName(code, code), answer: code, action: 'answer' })), later];
  // The stage registry default comes first; other registered profiles follow in registry order.
  if (stage.id === 'core:profile') return [...orderedProfiles(observation.profile.available, entry => entry.id).sort((a, b) => Number(b.id === stageRegistry.unattendedProfile) - Number(a.id === stageRegistry.unattendedProfile))
    .slice(0, registry.windowOptionRows - 1)
    .map((entry): Choice => { const profile = profiles.find(row => row.definition.id === entry.id && row.definition.version === entry.version);
      return { id: entry.id, label: profile ? profileLabel(profile, locale) : entry.id, answer: { id: entry.id, version: entry.version }, action: 'answer' }; }), later];
  const yes = (answer: unknown): Choice => ({ id: 'yes', label: t('setup.window.yes', {}, locale), answer, action: 'answer', role: 'yes' });
  if (stage.id === 'core:folder') return typeof stage.default === 'string' && stage.default ? [yes(stage.default), notNow] : [later];
  if (typeof stage.default === 'boolean') return [yes(true), { id: 'no', label: t('setup.window.no', {}, locale), answer: false, action: 'answer', role: 'no' }, later];
  return [later];
}

/** The recommended answer: the one the stage's default names (the detected language, the preset profile, a yes/no default), else the first. */
export const initialChoice = (stage: SetupStage | null, choices: readonly Choice[]) =>
  Math.max(0, stage?.default == null ? 0 : choices.findIndex(choice => choice.answer !== undefined && JSON.stringify(choice.answer) === JSON.stringify(stage.default)));
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
  const { context, root, flags } = input, later = new Set<string>(), results: SetupApplyResult[] = [];
  let locale = input.locale, observed = input.observed, values = unattendedAnswers(observed.observation, flags, true, observed.registry), note = '', pending: SetupStage | null = null;
  const plan = () => planFor(observed, values);
  const scopeId = () => typeof values['core:folder'] === 'string' ? values['core:folder'] : observed.observation.folder.configuredScope ?? null;
  const choices = (stage: SetupStage | null) => stageChoices(stage, observed.observation, locale, observed.registry, context.listIdentityProfiles?.([]).profiles);
  const model = (): SetupWindowModel => {
    const current = plan(), stage = activeStage(current, later), at = stage ? current.stages.indexOf(stage) : -1;
    const waiting = current.stages.filter(item => item.state !== 'done' && item.state !== 'skipped');
    const finished = !stage && waiting.length ? t('setup.window.deferred', { count: waiting.length, titles: waiting.map(item => stageTitle(item, locale)).join(', ') }, locale)
      : t('setup.window.finished', {}, locale);
    const rows = [...current.stages.map((item, index) => `${index === at ? '>' : ' '} ${index + 1}. ${stageTitle(item, locale)} · ${stageStateLabel(item, locale)}`), '',
      stage ? stageText(current, stage.reason.code, stage.reason.params, locale) : finished,
      stage?.question ? stageText(current, stage.question.key, stage.question.params, locale) : '',
      note || (stage && stageCommand(stage) ? `$ ${stageCommand(stage)}` : '')];
    // R05: the reason and the question wrap (not cut) inside a fixed row count each; the stage rows and the command keep one row.
    const heights = rows.map((_row, index) => index === rows.length - 3 ? registry.windowTextRows.reason : index === rows.length - 2 ? registry.windowTextRows.question : 1);
    const offered = choices(stage);
    return { title: t('setup.window.title', {}, locale), rows, heights, options: offered.map(({ id, label, role }) => role ? { id, label, role } : { id, label }),
      initial: initialChoice(stage, offered),
      optionRows: registry.windowOptionRows, hints: t('setup.window.hints', {}, locale), position: t('setup.window.position', {}, locale), reveal: Math.max(0, at) };
  };
  /** After an apply: the next state comes only from a fresh observation; a stage still open afterwards is put off (bounded, no loop). */
  const settle = async (stage: SetupStage, result: SetupApplyResult) => {
    results.push(result);
    if (result.status === 'applied') observed = await observeSetup(context, root, locale, true);
    const current = plan();
    note = applyLine(current, result, locale);
    if (result.status !== 'applied' || current.stages.find(item => item.id === stage.id)?.state !== 'done') later.add(stage.id);
  };
  const step = async (id: string): Promise<SetupWindowModel | null> => {
    const stage = activeStage(plan(), later), picked = choices(stage).find(choice => choice.id === id);
    if (!picked || picked.action === 'close' || !stage) return null;
    note = '';
    if (picked.action === 'later') later.add(stage.id);
    else if (picked.action === 'answer') {
      values = { ...values, [stage.id]: picked.answer };
      if (stage.id === 'core:language' && (LOCALES as readonly unknown[]).includes(picked.answer)) locale = picked.answer as Locale;
    }
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
  return { model, step, runPending, locale: () => locale, outcome: () => ({ plan: plan(), results: [...results], ...(observed.firstJob ? { firstJob: observed.firstJob } : {}) }) };
}
