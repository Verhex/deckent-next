import { ErrorRegistry, emit, t, loadConfig, terminalSafeText, redactSensitive, type ConfigLoadOptions } from '#platform/index.js';
import { commandLocale, type CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { askCliCard, cliMode } from '#surfaces/core/cli-human/index.js';
import type { BeuserReport } from '#engine/index.js';
import { formatBeuserReport } from './report.js';
type Model = { readonly channelId: string; readonly modelId: string; readonly recommended?: boolean; readonly subscription?: boolean };
/** The one-command walk's setup step (no `--scope`): the private controller, its connected models and, once a model is chosen, the candidate and limits. */
type SetupResult = { status: string; digest?: string; admission?: unknown; controller?: { root: string; scopeId: string | null }; models?: readonly Model[]; ceiling?: number; independence?: string; completionTokens?: number;
  slots?: { before: { executionSlots: number; inFlightSlots: number } | null; after: { executionSlots: number; inFlightSlots: number } };
  candidate?: { root: string; version: string; revision: string }; limits?: { maxSteps: number; maxWallMs: number; maxCalls: number; maxTokens: number; maxCost: number; currency: string } };
type SetupInput = { scopeId: string; profile: string; apply: boolean; expect?: string }
  | { journey: string; candidate?: string | undefined; walkers?: readonly Model[] | undefined; evaluator?: Model | undefined; apply: boolean; expect?: string | undefined };
const MS_PER_MINUTE = 60_000;
type Card = (request: Parameters<typeof askCliCard>[0]) => Promise<string | null>;
export interface BeuserCommandContext extends CliBaseContext {
  setupBeuser?: (root: string, input: SetupInput, options: ConfigLoadOptions) => Promise<SetupResult>;
  walkBeuser?: (root: string, input: { readonly scopeId: string; readonly journey: string; readonly candidate?: string | undefined }, options: ConfigLoadOptions, signal?: AbortSignal) => Promise<BeuserReport>;
  readBeuserReport?: (root: string, scopeId: string, runId: string | undefined, options: ConfigLoadOptions) => Promise<BeuserReport>;
}
export function parseBeuserArguments(argv: readonly string[]) {
  const action = argv[1]; if (argv[0] !== 'beuser' || !['setup', 'walk', 'report'].includes(action ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  const values = new Map<string, string>(), flags = new Set<string>();
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index]!; if (values.has(key) || flags.has(key)) throw ErrorRegistry.createError('CLI_USAGE');
    if (['--help', '-h', '--json', '--no-color', ...(action === 'setup' ? ['--apply'] : [])].includes(key)) flags.add(key);
    else if (['--scope', '--lang', ...(action === 'walk' ? ['--journey', '--candidate'] : action === 'setup' ? ['--profile'] : ['--run'])].includes(key)) {
      const value = argv[++index]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(key, value);
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const help = flags.has('--help') || flags.has('-h');
  if (!help && action === 'walk' && !values.has('--journey')) throw ErrorRegistry.createError('CLI_USAGE');
  if (!help && action === 'setup' && !values.has('--profile')) throw ErrorRegistry.createError('CLI_USAGE');
  return { action: action as 'setup' | 'walk' | 'report', help, json: flags.has('--json'), apply: flags.has('--apply'), profile: values.get('--profile'), language: values.get('--lang'), scope: values.get('--scope'),
    journey: values.get('--journey'), candidate: values.get('--candidate'), runId: values.get('--run') };
}
/** Help and parsing have no host effects. Only the composition's typed callbacks can admit work or open a retained report. */
export async function beuserCommand(argv: readonly string[], context: BeuserCommandContext = {}) {
  const args = parseBeuserArguments(argv), locale = commandLocale(context, args.language);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (args.help) { emit(args.action === 'setup' ? t('beuser.help.setup', {}, locale) : args.action === 'walk' ? t('beuser.help.walk', {}, locale) : t('beuser.help.report', {}, locale), sinks); return; }
  // A walk without --scope is the one-command flow (owner S9): it shows the person's model choice and setup card, so it needs the person's terminal like setup.
  const oneCommand = args.action === 'walk' && !args.scope;
  if ((args.action === 'setup' || oneCommand) && cliMode(context).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: argv.slice(0, 2).join(' ') } });
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const card: Card = async request => askCliCard(request, { locale, env: options.env,
    signal: AbortSignal.any([AbortSignal.timeout((await loadConfig(root, { ...options, heal: false })).approvals.sessionTtlMs), ...(context.signal ? [context.signal] : [])]),
    ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}) });
  if (oneCommand) return walkOneCommand(args.journey!, args.candidate, args.json, context, card, locale, sinks, options);
  const terminal = !args.scope ? (await loadConfig(root, options))['terminal'] as { scopeId?: string } | undefined : undefined;
  const scopeId = args.scope ?? terminal?.scopeId;
  if (!scopeId) throw ErrorRegistry.createError('CLI_SCOPE_REQUIRED', { params: { command: argv.slice(0, 2).join(' '), scopes: '' } });
  if (args.action === 'setup') {
    if (!context.setupBeuser) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    const input = { scopeId, profile: args.profile!, apply: false }, preview = await context.setupBeuser(root, input, options);
    let result = preview;
    if (args.apply) {
      const answer = await card({ title: t('beuser.setup.card', {}, locale),
        body: [t('beuser.setup.change', { scope: terminalSafeText(scopeId), digest: preview.digest ?? '' }, locale), terminalSafeText(redactSensitive(JSON.stringify(preview.admission)))],
        options: [{ id: 'apply', role: 'yes', label: t('beuser.setup.apply', {}, locale) }, { id: 'cancel', role: 'no', label: t('beuser.setup.cancel', {}, locale) }] });
      if (answer === 'apply') result = await context.setupBeuser(root, { ...input, apply: true, ...(preview.digest ? { expect: preview.digest } : {}) }, options);
      else result = { ...preview, status: 'cancelled' };
    }
    emit(args.json ? JSON.stringify(result) : t('beuser.setup.result', { status: result.status, digest: result.digest ?? '' }, locale), sinks); return;
  }
  let report;
  if (args.action === 'walk') {
    if (!context.walkBeuser) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    report = await context.walkBeuser(root, { scopeId, journey: args.journey!, candidate: args.candidate }, options, context.signal);
  } else {
    if (!context.readBeuserReport) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    report = await context.readBeuserReport(root, scopeId, args.runId, options);
  }
  emit(formatBeuserReport(report, { json: args.json, locale }), sinks);
}

/** Journey beuser-one-command B1/B2/B4: controller → the person's model choice → setup card → walk → report, from any folder. A refused card applies nothing. */
async function walkOneCommand(journey: string, candidate: string | undefined, json: boolean, context: BeuserCommandContext, card: Card,
  locale: ReturnType<typeof commandLocale>, sinks: Parameters<typeof emit>[1], options: ConfigLoadOptions) {
  if (!context.setupBeuser || !context.walkBeuser) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
  // The controller comes from the person's global state root, never from the current folder.
  const input = { journey, candidate, apply: false }, step = await context.setupBeuser('', input, options), models = step.models ?? [], controller = step.controller;
  const at = { controller: terminalSafeText(controller?.root ?? '') }, cancelled = () => emit(t('beuser.walk.cancelled', {}, locale), sinks);
  if (!controller?.scopeId || !models.length) { emit(t('beuser.walk.connect', at, locale), { ...sinks, level: 'warning' }); throw ErrorRegistry.createError('BEUSER_MODEL_UNAVAILABLE'); }
  const label = (model: Model) => terminalSafeText(`${model.channelId} / ${model.modelId}`);
  const selected = new Set(models.flatMap((model, index) => model.recommended ? [index] : []));
  const ceiling = step.ceiling!;
  let selectionError = '';
  for (;;) {
    const picked = await card({ title: t('beuser.walk.model', {}, locale),
      body: [t('beuser.walk.modelBody', { ...at, ceiling }, locale), ...(selectionError ? [selectionError] : [])], initial: 'continue',
      options: [...models.map((model, index) => ({ id: String(index), label: `${selected.has(index) ? '[x]' : '[ ]'} ${model.recommended ? t('beuser.walk.recommended', { model: label(model) }, locale) : label(model)}` })),
        { id: 'continue', label: t('beuser.walk.continue', {}, locale) }] });
    if (picked === null) { cancelled(); return; }
    if (picked === 'continue') {
      if (selected.size > 0 && selected.size <= ceiling) break;
      selectionError = t('beuser.walk.selectionLimit', { ceiling, count: selected.size }, locale); continue;
    }
    const index = Number(picked);
    if (models[index]) { if (selected.has(index)) selected.delete(index); else selected.add(index); }
  }
  const walkers = [...selected].sort((a, b) => a - b).map(index => ({ channelId: models[index]!.channelId, modelId: models[index]!.modelId }));
  const preferred = models.findIndex(model => model.recommended && model.subscription), first = models.findIndex(model => model.recommended);
  const judge = await card({ title: t('beuser.walk.judge', {}, locale), body: [t('beuser.walk.judgeBody', {}, locale)], initial: String(preferred >= 0 ? preferred : Math.max(0, first)),
    options: models.map((model, index) => ({ id: String(index), label: label(model) })) });
  const choice = judge === null ? undefined : models[Number(judge)];
  if (!choice) { cancelled(); return; }
  const evaluator = { channelId: choice.channelId, modelId: choice.modelId };
  const preview = await context.setupBeuser('', { ...input, walkers, evaluator }, options), limits = preview.limits!, chosen = preview.candidate!, slots = preview.slots!;
  const answer = await card({ title: t('beuser.walk.card', {}, locale), body: [t('beuser.walk.cardBody', { journey: terminalSafeText(journey), version: terminalSafeText(chosen.version),
    revision: terminalSafeText(chosen.revision), steps: limits.maxSteps, minutes: Math.ceil(limits.maxWallMs / MS_PER_MINUTE), calls: limits.maxCalls * walkers.length, cost: limits.maxCost * walkers.length,
    tokens: limits.maxTokens * walkers.length, currency: terminalSafeText(limits.currency), digest: preview.digest ?? '' }, locale),
    ...walkers.map((walker, index) => t('beuser.walk.walker', { index: index + 1, model: label(walker), cost: limits.maxCost, currency: limits.currency,
      tokens: limits.maxTokens, completion: preview.completionTokens! }, locale)),
    t('beuser.walk.evaluator', { model: label(evaluator), independence: preview.independence ?? 'unknown' }, locale),
    t('beuser.walk.slots', { before: slots.before ? `${slots.before.executionSlots}/${slots.before.inFlightSlots}` : t('beuser.walk.newPool', {}, locale),
      after: `${slots.after.executionSlots}/${slots.after.inFlightSlots}`, ceiling }, locale)],
    options: [{ id: 'apply', role: 'yes', label: t('beuser.setup.apply', {}, locale) }, { id: 'cancel', role: 'no', label: t('beuser.setup.cancel', {}, locale) }] });
  if (answer !== 'apply') { cancelled(); return; }
  const applied = await context.setupBeuser('', { ...input, walkers, evaluator, apply: true, expect: preview.digest }, options);
  if (applied.status !== 'applied' && applied.status !== 'current') { emit(t('beuser.setup.result', { status: applied.status, digest: applied.digest ?? '' }, locale), sinks); return; }
  const report = await context.walkBeuser(controller.root, { scopeId: controller.scopeId, journey, candidate: chosen.root }, options, context.signal);
  emit(formatBeuserReport(report, { json, locale }), sinks);
  if (!json) emit(t('beuser.walk.next', { ...at, revision: terminalSafeText(chosen.revision) }, locale), sinks);
}
