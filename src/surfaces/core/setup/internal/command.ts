import { ErrorRegistry, emit, type Locale } from '#platform/index.js';
import { planSetup, SETUP_PLAN_SCHEMA_VERSION, type SetupObservation, type SetupPlan, type SetupStageRegistry } from '#engine/index.js';
import { cliMode, resolveCommandScope, scopeLister } from '#surfaces/core/cli-human/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { notWiredApply, type SetupApplyResult, type SetupCommandContext } from './contract.js';
import { observeSetup } from './observe.js';
import { renderSetupLines, setupDocument } from './render.js';
import registry from './modes.json' with { type: 'json' };

export type SetupFormat = 'json' | 'plain' | 'interactive';
/** INIT-D7 through the one L-KIT decision: `--json`, an AI agent or CI get the JSON document; a pipe or a dumb terminal plain lines; only a
 * person on a real terminal gets the window. UX only: no format grants or removes authority. */
export function setupFormat(context: SetupCommandContext, json: boolean): SetupFormat {
  return registry.formats[cliMode(context, json).reason] as SetupFormat;
}
export type SetupFlags = Readonly<{ json: boolean; yes: boolean; scope?: string; lang?: string }>;
export function parseSetupFlags(argv: readonly string[]): SetupFlags {
  let json = false, yes = false, scope: string | undefined, lang: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index], value = () => { const next = argv[++index]; if (!next || next.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); return next; };
    if (flag === '--json' && !json) json = true;
    else if (flag === '--yes' && !yes) yes = true;
    else if (flag === '--scope' && scope === undefined) scope = value();
    else if (flag === '--lang' && lang === undefined) lang = value();
    else if (flag !== '--no-color') throw ErrorRegistry.createError('CLI_USAGE');
  }
  return { json, yes, ...(scope === undefined ? {} : { scope }), ...(lang === undefined ? {} : { lang }) };
}

/** The answers a call brings without a window: `--scope` answers the folder stage (never derived); without a person the profile is solo
 * (INIT-D4, ANALYSIS §4.2 row 4); `--yes` (INIT-D5) also confirms the detected language and a fresh first-run policy, nothing else. */
export function unattendedAnswers(observation: SetupObservation, flags: SetupFlags, person: boolean): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  if (flags.scope !== undefined) values['core:folder'] = flags.scope;
  const solo = observation.profile.available.find(entry => entry.id === 'core:solo');
  if (!person && solo) values['core:profile'] = { id: solo.id, version: solo.version };
  if (flags.yes) {
    const language = observation.language;
    if (!language.configured) values['core:language'] = language.requested ?? language.system ?? 'en';
    if (observation.policy.state === 'absent') values['core:policy'] = true;
  }
  return values;
}
export const planFor = (observed: Readonly<{ observation: SetupObservation; registry: SetupStageRegistry }>, values: Readonly<Record<string, unknown>>): SetupPlan =>
  planSetup(observed.observation, { schemaVersion: SETUP_PLAN_SCHEMA_VERSION, values: { ...values } }, observed.registry);

/**
 * Bare `deckent init` (I-S4): detect → plan → render. Without a person nothing is applied; `--yes` applies only stages the planner marks
 * `autoEligible` (fresh policy, language, final check), one at a time, each followed by a fresh observation. The apply port answers
 * `not-wired` until I-S3 wires each operation to its existing owner; then this command says so and exits with SETUP_APPLY_UNAVAILABLE.
 */
export async function setupInitCommand(argv: readonly string[], context: SetupCommandContext): Promise<void> {
  const flags = parseSetupFlags(argv), locale: Locale = commandLocale(context, flags.lang);
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, format = setupFormat(context, flags.json);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  // INIT-D5: `--yes` names its scope; it is refused before anything is observed, with the valid scopes listed.
  if (flags.yes) await resolveCommandScope({ command: 'deckent init --yes', locale, explicit: flags.scope, mutating: true, interactive: false,
    listScopes: () => scopeLister(context, root, { env })().catch(() => []) });
  let observed = await observeSetup(context, root, flags.lang);
  if (format === 'interactive' && !flags.yes) {
    const stdin = (context.stdin ?? process.stdin) as NodeJS.ReadStream, stdout = (context.stdout ?? process.stdout) as NodeJS.WriteStream;
    if (typeof stdin.setRawMode !== 'function') throw ErrorRegistry.createError('TERMINAL_TTY_REQUIRED');
    const [{ createSetupController }, { mountSetupWindow }] = await Promise.all([import('./controller.js'), import('#surfaces/core/project-instructions/index.js')]);
    const controller = createSetupController({ context, root, locale, observed, flags });
    await mountSetupWindow(controller.model(), controller.step, { stdin, stdout, env });
    const outcome = controller.outcome();
    emit(renderSetupLines(outcome.plan, locale, { requested: false, results: outcome.results }), sinks);
    return;
  }
  let plan = planFor(observed, unattendedAnswers(observed.observation, flags, false));
  const results: SetupApplyResult[] = [], apply = context.applySetupStage ?? notWiredApply;
  // Bounded by the stage count: each round applies one eligible stage, then re-detects; a stage is never attempted twice in a call.
  for (let round = 0; flags.yes && round < plan.stages.length; round++) {
    const next = plan.stages.find(stage => stage.autoEligible && stage.state === 'ready' && stage.operation && !results.some(result => result.stage === stage.id));
    if (!next) break;
    const result = await apply(root, next, { env });
    results.push(result);
    if (result.status !== 'applied') break;
    observed = await observeSetup(context, root, flags.lang);
    plan = planFor(observed, unattendedAnswers(observed.observation, flags, false));
  }
  const outcome = { requested: flags.yes, results };
  if (format === 'json') emit(setupDocument(plan, outcome), { ...sinks, json: true });
  else emit(renderSetupLines(plan, locale, outcome), sinks);
  if (results.some(result => result.status === 'not-wired')) throw ErrorRegistry.createError('SETUP_APPLY_UNAVAILABLE');
}
