import { ErrorRegistry, emit, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { terminalConfigWrite, type ConfigCommandContext } from './command.js';

export type BrainOfferTarget = Readonly<{ channelId: string; modelId: string }>;
const KEY = 'brain_planner.excluded';
const same = (row: BrainOfferTarget, target: BrainOfferTarget) => row.channelId === target.channelId && row.modelId === target.modelId;

/**
 * Owner 2026-11-06 ("can be Brain", default on): the one writer of `brain_planner.excluded`, through the governed config writer (policy,
 * approval and audit as any `/config` write). It writes the layer that already holds the list, else the user layer, so the change is the one read.
 */
export async function setBrainOffer(root: string, target: BrainOfferTarget, offered: boolean, context: ConfigCommandContext, options: ConfigLoadOptions,
  locale: Locale, surface: 'terminal' | 'cli' = 'terminal') {
  if (!context.configApplication) throw ErrorRegistry.createError('CLI_USAGE');
  const config = await loadConfig(root, options), current = (config['brain_planner'] as { excluded?: readonly BrainOfferTarget[] } | undefined)?.excluded ?? [];
  const layer = (await context.configApplication(root, options).inspectValue({ keyPath: KEY, layer: 'project' })).value === undefined ? 'global' as const : 'project' as const;
  const rest = current.filter(row => !same(row, target)).map(row => ({ channelId: row.channelId, modelId: row.modelId }));
  const outcome = await terminalConfigWrite(root, { action: 'set', keyPath: KEY, value: offered ? rest : [...rest, { ...target }], layer }, context, options, locale, surface);
  const model = terminalSafeText(target.modelId);
  return outcome.status !== 'applied' ? outcome
    : { ...outcome, lines: [offered ? t('tui.model.brain.offerDone', { model }, locale) : t('tui.model.brain.withdrawDone', { model }, locale), ...outcome.lines] };
}

/** `deckent models catalog brain --channel <id> --model <exact id> --on|--off`: the CLI twin of the `/model` row's "can be Brain" switch. */
export async function brainOfferCommand(argv: readonly string[], context: ConfigCommandContext): Promise<void> {
  const values = new Map<string, string>(); let state: boolean | undefined, json = false, language: string | undefined, help = false;
  for (let index = 3; index < argv.length; index++) {
    const flag = argv[index]!;
    if ((flag === '--on' || flag === '--off') && state === undefined) { state = flag === '--on'; continue; }
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--help' || flag === '-h') { help = true; continue; }
    if (flag === '--no-color') continue;
    const value = argv[++index];
    if (!['--channel', '--model', '--lang'].includes(flag) || values.has(flag) || !value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
    if (flag === '--lang') language = value; else values.set(flag, value);
  }
  const locale = commandLocale(context, language), sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (help) { emit(t('cli.help.modelsCatalogBrain', {}, locale), sinks); return; }
  const channelId = values.get('--channel'), modelId = values.get('--model');
  if (!channelId || !modelId || state === undefined) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), options: ConfigLoadOptions = { env: context.env ?? process.env, heal: false };
  // The exact model id of a declared catalog channel (the key the Brain gate reads); an unknown pair is refused, never written.
  const declared = ((await loadConfig(root, options))['provider_catalog'] as { providers?: readonly { id: string; models: readonly { nativeId: string }[] }[] } | undefined)?.providers;
  if (!declared?.some(provider => provider.id === channelId && provider.models.some(model => model.nativeId === modelId))) throw ErrorRegistry.createError('MODEL_CATALOG_NOT_FOUND');
  const outcome = await setBrainOffer(root, { channelId, modelId }, state, context, options, locale, 'cli');
  emit({ status: outcome.status, approvalId: outcome.approvalId, channelId, modelId, offeredAsBrain: state },
    { ...sinks, json, level: outcome.status === 'applied' ? 'info' : 'warning', render: () => outcome.lines.join('\n') });
}
