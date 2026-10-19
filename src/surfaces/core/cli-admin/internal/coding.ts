import { resolve } from 'node:path';
import { ErrorRegistry, emit, loadConfig, t, type ConfigLoadOptions, type DeckentConfig, type Locale } from '#platform/index.js';
import { executionProfileDefinitionSchema, executionRegistrySchema, type ExecutionProfileDefinition } from '#domain/index.js';
import { affectedToolchainProfiles } from '#engine/index.js';
import { commandLocale, readJsonInput } from '#surfaces/core/cli-kit/index.js';
import { askCliCard, cliMode, cliTableStyle, renderCliTable, type CliCardOption } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';

export type CodingProfilePreparationHandler = (input: unknown) => Readonly<{
  schemaVersion: 1; profile: ExecutionProfileDefinition; activation: 'not-activated';
}>;

/** Flags of one `coding` call: switches once each, valued flags once each with a value; anything else is a usage error. */
function readFlags(argv: readonly string[], from: number, allowed: readonly string[]) {
  const values = new Map<string, string>(), flags = new Set<string>();
  for (let i = from; i < argv.length; i++) {
    const flag = argv[i]!;
    if (['--json', '--preview', '--apply'].includes(flag) && allowed.includes(flag) && !flags.has(flag)) { flags.add(flag); continue; }
    if (!allowed.includes(flag) || values.has(flag) || flags.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE');
    values.set(flag, value);
  }
  return { values, flags };
}
const sinksOf = (context: AdminCommandContext) => ({ ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
const shortImage = (image: string | null | undefined) => image ? image.replace(/^sha256:/u, '').slice(0, 12) : '-';
type Pins = ReturnType<typeof affectedToolchainProfiles>;

export async function codingCommand(argv: readonly string[], context: AdminCommandContext): Promise<void> {
  if (argv[1] === 'template') return codingTemplateCommand(argv, context);
  const help = argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h');
  // C-SETUP (review §coding): bare `deckent coding` reads this installation's coding profiles; it is never a usage error.
  if (!help && (argv[1] === undefined || argv[1].startsWith('--'))) return codingList(argv, context);
  if (!help && argv[1] !== 'prepare') throw ErrorRegistry.createError('CLI_USAGE');
  const { values, flags } = help ? { values: new Map<string, string>(), flags: new Set<string>() } : readFlags(argv, 2, ['--json', '--input', '--lang']);
  const locale = commandLocale(context, values.get('--lang')), source = values.get('--input'), sinks = sinksOf(context);
  if (help) { emit(t('cli.coding.help', {}, locale), sinks); return; }
  if (!source || !context.prepareCodingProfile) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd();
  const config = await loadConfig(root, { env: context.env ?? process.env });
  const input = await readJsonInput(source === '-' ? source : resolve(root, source), config.installation.profileMaxBytes,
    { limit: 'CLI_CODING_INPUT_LIMIT', invalid: 'CLI_CODING_INPUT_INVALID', tty: 'CLI_CODING_INPUT_TTY', unavailable: 'CLI_CODING_INPUT_UNAVAILABLE' }, context.stdin);
  preparationShape(input, locale);
  const result = context.prepareCodingProfile(input);
  // The output is a preparation artifact, never evidence that a worker was started.
  emit(result, { ...sinks, json: flags.has('--json'), render: value => JSON.stringify(value, null, 2) });
}

/** The preparation document's envelope (`schemaVersion`, `template`, `invocation`): the first field that does not fit is named before the
 * preparation runs; the invocation's own details stay with the preparation (its typed error). */
function preparationShape(input: unknown, locale: Locale): void {
  const fail = (field: string): never => { throw ErrorRegistry.createError('CLI_CODING_PREPARE_FIELD_INVALID', { params: { field }, locale }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('schemaVersion');
  const document = input as Record<string, unknown>;
  const extra = Object.keys(document).find(key => !['schemaVersion', 'template', 'invocation'].includes(key));
  if (extra) fail(extra);
  if (document['schemaVersion'] !== 1) fail('schemaVersion');
  const template = executionProfileDefinitionSchema.safeParse(document['template']);
  if (!template.success) fail(['template', ...template.error.issues[0]?.path ?? []].join('.'));
  if (!document['invocation'] || typeof document['invocation'] !== 'object' || Array.isArray(document['invocation'])) fail('invocation');
}

/** The coding profiles task kinds run on: kind, profile, provider and CLI pin, image. Read from the admission registry only. */
function codingProfiles(config: DeckentConfig, pins: Pins) {
  const registry = executionRegistrySchema.safeParse(config.admission?.registry);
  if (!registry.success) return [];
  return registry.data.kinds.map(kind => {
    const pin = pins.find(item => item.profile.id === kind.profile.id && item.profile.version === kind.profile.version);
    return { kind: kind.kind, profile: { id: kind.profile.id, version: kind.profile.version }, provider: pin?.provider ?? null, cliVersion: pin?.cliVersion ?? null,
      imageId: pin?.imageId ?? null };
  });
}
async function codingList(argv: readonly string[], context: AdminCommandContext): Promise<void> {
  const { values, flags } = readFlags(argv, 1, ['--json', '--lang']);
  const locale = commandLocale(context, values.get('--lang'));
  const config = await loadConfig(context.root ?? process.cwd(), { env: context.env ?? process.env, heal: false });
  const profiles = codingProfiles(config, affectedToolchainProfiles(config)), configured = config.execution?.docker?.imageId ?? null;
  // The configured image runs none of the admitted CLIs: `coding template` without `--image` would find no toolchain there.
  const unused = configured !== null && profiles.some(row => row.provider) && !profiles.some(row => row.imageId === configured);
  emit({ schemaVersion: 1 as const, profiles, configuredImageId: configured }, { ...sinksOf(context), json: flags.has('--json'), render: data => {
    if (!data.profiles.length) return t('clisetup.coding.none', {}, locale);
    const columns = t('clisetup.coding.columns', {}, locale).split('|').map((header, index) => ({ header, shrink: index === 1 }));
    return [t('clisetup.coding.title', { count: data.profiles.length }, locale),
      renderCliTable(columns, data.profiles.map(row => [row.kind, `${row.profile.id}@${row.profile.version}`, row.provider ?? '-', row.cliVersion ?? '-', shortImage(row.imageId)]),
        cliTableStyle(context)),
      t('clisetup.coding.configuredImage', { image: shortImage(configured) }, locale), ...(unused ? [t('clisetup.coding.imageUnused', {}, locale)] : []),
      t('clisetup.coding.next', {}, locale)].join('\n');
  } });
}

export type CodingTemplateHandler = (root: string, input: { provider: string; kind: string; image?: string; apply: boolean },
  options: ConfigLoadOptions) => Promise<{ status: 'preview' | 'applied' | 'unchanged'; profile: ExecutionProfileDefinition; kind: unknown;
    registry: { revision: string }; expect: string | null; write: unknown }>;
type TemplateResult = Awaited<ReturnType<CodingTemplateHandler>>;

/**
 * `coding template`: on a person's terminal each missing choice is asked (admitted provider → task kind → admitted image), then the preview
 * card, and only "apply" writes; off a terminal a missing `--provider`/`--kind` lists the admitted choices and `--preview`/`--apply` stays required.
 */
async function codingTemplateCommand(argv: readonly string[], context: AdminCommandContext) {
  const { values, flags } = readFlags(argv, 2, ['--preview', '--apply', '--json', '--provider', '--kind', '--image', '--lang']);
  if (flags.has('--preview') && flags.has('--apply') || !context.configureCodingTemplate) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, locale = commandLocale(context, values.get('--lang'));
  const config = await loadConfig(root, { env, heal: false }), pins = affectedToolchainProfiles(config);
  const providers = [...new Set(pins.map(pin => pin.provider))];
  const io = { locale, env, ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}),
    ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}), ...(context.signal ? { signal: context.signal } : {}) };
  const person = cliMode(context, flags.has('--json')).mode === 'interactive';
  // One choice needs no question; the preview card still shows it.
  const ask = async (title: string, options: readonly CliCardOption[]) => options.length === 1 ? options[0]!.id : await askCliCard({ title, options }, io) ?? undefined;
  const missing = (flag: string, choices: readonly string[]) => ErrorRegistry.createError('CLI_CODING_TEMPLATE_CHOICE_MISSING',
    { params: { flag, values: choices.length ? choices.join(', ') : t('clisetup.coding.noChoices', {}, locale) }, locale });
  let provider = values.get('--provider');
  if (!provider && !person) throw missing('--provider <id>', providers);
  if (!provider) {
    if (!providers.length) throw ErrorRegistry.createError('CODING_TEMPLATE_TOOLCHAIN_REQUIRED', { locale });
    provider = await ask(t('clisetup.coding.ask.provider', {}, locale), providers.map(id => ({ id, label: id })));
    if (!provider) return;
  }
  const kinds = templateKinds(config, pins, provider);
  let kind = values.get('--kind');
  if (!kind && !person) throw missing('--kind <id>', kinds);
  if (!kind) { kind = await ask(t('clisetup.coding.ask.kind', { provider }, locale), kinds.map(id => ({ id, label: id }))); if (!kind) return; }
  let image = values.get('--image');
  const images = [...new Set(pins.filter(pin => pin.provider === provider && pin.imageId).map(pin => pin.imageId!))];
  if (!image && person && images.length) {
    const chosen = provider;
    image = await ask(t('clisetup.coding.ask.image', { provider }, locale), images.map(id => ({ id, label: imageLabel(id, pins, chosen) })));
    if (!image) return;
  }
  // Off a terminal the write intent stays explicit: `--preview` or `--apply` (the flag contract AI callers already use).
  if (!person && !flags.has('--preview') && !flags.has('--apply')) throw ErrorRegistry.createError('CLI_USAGE');
  const request = { provider, kind, ...(image ? { image } : {}) }, run = (apply: boolean) => template(context, root, env, config, { ...request, apply }, locale);
  const sinks = { json: flags.has('--json'), ...sinksOf(context) }, show = (result: TemplateResult) => emit(output(result), { ...sinks, render: value => renderTemplate(value, locale) });
  if (!person || flags.has('--preview') || flags.has('--apply')) { show(await run(flags.has('--apply'))); return; }
  const preview = await run(false);
  if (preview.status !== 'preview') { show(preview); return; }
  const answer = await askCliCard({ title: t('clisetup.coding.card.title', {}, locale), body: templateLines(output(preview), locale),
    options: [{ id: 'apply', label: t('clisetup.coding.card.apply', {}, locale), key: 'y' }, { id: 'no', label: t('clisetup.coding.card.cancel', {}, locale), key: 'n' }] }, io);
  if (answer !== 'apply') { emit(t('clisetup.coding.card.cancelled', {}, locale), { ...sinks, json: false }); return; }
  show(await run(true));
}
/** Kinds a template can bind for `provider`: the kinds already on its admitted profiles, then the conventional new ones still free. */
function templateKinds(config: DeckentConfig, pins: Pins, provider: string): string[] {
  const rows = codingProfiles(config, pins), taken = new Set(rows.map(row => row.kind));
  return [...new Set([...rows.filter(row => row.provider === provider).map(row => row.kind), ...['coding', `${provider}-coding`].filter(kind => !taken.has(kind))])];
}
const imageLabel = (image: string, pins: Pins, provider: string) =>
  `${shortImage(image)} · ${pins.filter(pin => pin.provider === provider && pin.imageId === image).map(pin => pin.cliVersion).join(', ')}`;
async function template(context: AdminCommandContext, root: string, env: NodeJS.ProcessEnv, config: DeckentConfig,
  request: { provider: string; kind: string; image?: string; apply: boolean }, locale: Locale): Promise<TemplateResult> {
  try { return await context.configureCodingTemplate!(root, request, { env, heal: false }); }
  catch (error) { throw unadmittedImage(error, config, request, locale) ?? error; }
}
/** Root cause of CODING_TEMPLATE_TOOLCHAIN_REQUIRED on a working installation (review §coding open question): without `--image` the template
 * looks for an admitted CLI on `execution.docker.imageId`, but the admitted profiles run on other images. Named with those images and a command. */
function unadmittedImage(error: unknown, config: DeckentConfig, request: { provider: string; kind: string; image?: string }, locale: Locale) {
  if ((error as { code?: unknown } | null)?.code !== 'CODING_TEMPLATE_TOOLCHAIN_REQUIRED') return null;
  const used = request.image ?? config.execution?.docker?.imageId ?? null;
  const pins = affectedToolchainProfiles(config).filter(pin => pin.provider === request.provider && pin.imageId), images = [...new Set(pins.map(pin => pin.imageId!))];
  if (!images.length || (used && images.includes(used))) return null;
  return ErrorRegistry.createError('CLI_CODING_TEMPLATE_IMAGE_UNADMITTED', { cause: error, locale, params: { provider: request.provider, image: shortImage(used),
    images: images.map(image => imageLabel(image, pins, request.provider)).join('; '), kind: request.kind, admitted: images[0]! } });
}
const output = (result: TemplateResult) => ({ schemaVersion: 1 as const, status: result.status, profile: result.profile, kind: result.kind,
  registryRevision: result.registry.revision, expect: result.expect, write: result.write });
function templateLines(value: ReturnType<typeof output>, locale: Locale): string[] {
  const parameters = value.profile.parameters as { docker?: { imageId?: string }; invocation?: { provider?: string; cliVersion?: string } };
  return [t('clisetup.coding.result.profile', { profile: `${value.profile.id}@${value.profile.version}` }, locale),
    t('clisetup.coding.result.kind', { kind: String((value.kind as { kind?: unknown } | null)?.kind ?? '-') }, locale),
    t('clisetup.coding.result.toolchain', { provider: parameters.invocation?.provider ?? '-', cli: parameters.invocation?.cliVersion ?? '-',
      image: shortImage(parameters.docker?.imageId) }, locale),
    t('clisetup.coding.result.registry', { revision: value.registryRevision }, locale)];
}
function renderTemplate(value: ReturnType<typeof output>, locale: Locale): string {
  const head = value.status === 'preview' ? t('cli.coding.template.preview', {}, locale) : value.status === 'applied' ? t('cli.coding.template.applied', {}, locale)
    : t('cli.coding.template.unchanged', {}, locale);
  return [head, ...templateLines(value, locale), ...(value.status === 'preview' ? [t('clisetup.coding.applyHint', {}, locale)] : [])].join('\n');
}
