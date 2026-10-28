import { randomUUID } from 'node:crypto';
import { ErrorRegistry, EXIT_CODES, MESSAGE_REGISTRY, emit, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { resolveCommandScope, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import { askModelsCard, modelsConfirmOptions, modelsInteractive, modelsSinks, reportModelsCancelled } from './io.js';
import { modelConnectCommandSchema, type ModelConnectCommand, type ModelConnectResult } from '#domain/index.js';
import type { ModelCommandContext } from './context.js';
import { SCOPE_BUDGET_CHOICES } from './budget.js';

export type ModelConnectHandler = (root: string, command: ModelConnectCommand, options: ConfigLoadOptions) => Promise<ModelConnectResult>;
const FLAGS = ['--scope', '--connection', '--endpoint', '--model', '--reference', '--command-id', '--lang', '--executable', '--config-dir', '--delegate'] as const;
/** `provider@version/model@version`: the exact catalog reference the terminal and `models binding` show. */
const REFERENCE = /^([^@/\s]+)@([1-9]\d*)\/([^@/\s]+)@([1-9]\d*)$/u;

const usage = (flag: string) => ErrorRegistry.createError('CLI_USAGE', { params: { command: t('climodels.budget.command', { action: 'connect' }), flag } });
function parse(argv: readonly string[]) {
  const values = new Map<string, string>(); let json = false, help = false;
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index]!;
    if ((flag === '--json' && !json)) { json = true; continue; }
    if (flag === '--no-color') continue;
    if ((flag === '--help' || flag === '-h') && !help) { help = true; continue; }
    if (!(FLAGS as readonly string[]).includes(flag) || values.has(flag)) throw usage(flag); // BeUser M-26: the refusal names the argument
    const value = argv[++index]; if (!value || value.startsWith('-')) throw usage(flag);
    values.set(flag, value);
  }
  if (help) return { help, json, values };
  if (!values.has('--connection')) throw usage('--connection'); // --scope defaults to this folder's scope, --command-id is generated (M-26)
  if (values.has('--model') && values.has('--reference')) throw usage('--reference');
  return { help, json, values };
}
const stepWord = (state: string, locale: Locale) => state === 'written' ? t('models.connect.step.written', {}, locale)
  : state === 'present' ? t('models.connect.step.present', {}, locale) : t('models.connect.step.skipped', {}, locale);
/** The person's summary: what is connected, under which key name, what each governed step did and what (if anything) still waits. */
export function renderModelConnect(result: ModelConnectResult, locale: Locale, resume?: ModelConnectCommand): string {
  const reference = `${result.reference.providerId}@${result.reference.providerVersion}/${result.reference.modelId}@${result.reference.modelVersion}`;
  // BeUser alpha.56.1 (Ayşe): a pull leads with the human result (each model and its state), then the scope and reference, the key, the bookkeeping
  // steps. A single `--model`/`--reference` connect has no per-model rows and still opens with the reference line.
  const lines = (result.models ?? []).map(model => { const params = { model: terminalSafeText(model.nativeId) };
    return model.state === 'connected' ? t('models.connect.pull.connected', params, locale) : model.state === 'unpriced' ? t('models.connect.pull.unpriced', params, locale)
      : model.state === 'notOnKey' ? t('models.connect.pull.notOnKey', params, locale) : t('models.connect.pull.notInCatalog', params, locale); });
  lines.push(result.status === 'connected' ? t('models.connect.connected', { reference, scope: result.scopeId }, locale)
    : resume ? t('models.connect.pendingResume', { reference, key: result.approval?.keyPath ?? '-', approval: result.approval?.approvalId ?? '-', command: resumeCommand(resume) }, locale) // Astra R3: the same id resumes
      : t('models.connect.pending', { reference, key: result.approval?.keyPath ?? '-', approval: result.approval?.approvalId ?? '-' }, locale),
  result.credentialRef === null ? t('models.connect.keyNone', {}, locale) : result.keyStored === false ? t('models.connect.keyMissing', { name: result.credentialRef }, locale)
    : t('models.connect.key', { name: result.credentialRef }, locale),
  t('models.connect.steps', { catalog: stepWord(result.steps.catalog, locale), declaration: stepWord(result.steps.declaration, locale),
    profile: stepWord(result.steps.profile, locale), activation: stepWord(result.steps.activation, locale), carried: result.steps.carried }, locale));
  if (result.notCarried.length) lines.push(t('models.connect.notCarried', { models: result.notCarried.map(item => `${item.reference.providerId}@${item.reference.providerVersion}/`
    + `${item.reference.modelId}@${item.reference.modelVersion} (${item.code})`).join(', ') }, locale));
  if (result.tariff === 'unmetered') lines.push(t('models.connect.unmetered', {}, locale));
  if (result.budget?.state === 'missing') lines.push(t('models.connect.budgetMissing', { scope: result.scopeId, usd: SCOPE_BUDGET_CHOICES.defaultPresetUsd }, locale));
  if (result.budget?.state === 'unknown') lines.push(t('models.connect.budgetUnknown', { scope: result.scopeId, code: result.budget.code ?? '-' }, locale));
  if (result.service === 'stale') lines.push(t('models.connect.restart', {}, locale));
  // S3-3: the CLI login it uses and who besides the person may spend it (the consent the person wrote).
  if (result.cli) lines.push(result.cli.owned ? t('headless.connect.loginOwned', { dir: result.cli.configDir }, locale) : t('headless.connect.login', { dir: result.cli.configDir }, locale), result.cli.delegate.length
    ? t('headless.connect.delegated', { classes: result.cli.delegate.join(', ') }, locale) : t('headless.connect.personOnly', {}, locale));
  return lines.join('\n');
}

const word = (value: string) => /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
/** Astra R3: the exact command that resumes this connection after its approval (same command id, so the same approval applies). */
export function resumeCommand(command: ModelConnectCommand): string {
  const model = 'nativeId' in command.model ? ['--model', command.model.nativeId] : 'reference' in command.model
    ? ['--reference', `${command.model.reference.providerId}@${command.model.reference.providerVersion}/${command.model.reference.modelId}@${command.model.reference.modelVersion}`] : [];
  return [t('climodels.budget.command', { action: 'connect' }), '--scope', command.scopeId, '--connection', command.connection, ...(command.endpoint ? ['--endpoint', command.endpoint] : []), ...model,
    ...(command.cli?.executable ? ['--executable', command.cli.executable] : []), ...(command.cli?.configDir ? ['--config-dir', command.cli.configDir] : []),
    ...(command.delegate ? ['--delegate', command.delegate.length ? command.delegate.join(',') : 'none'] : []), '--command-id', command.commandId].map((part, index) => index === 0 ? part : word(part)).join(' ');
}
/** `deckent models connect` (T4-B D2): the same `models.connect` application as SDK `connectModel`, MCP `connect_model` and the terminal. */
export async function modelConnectCommand(argv: readonly string[], context: ModelCommandContext): Promise<void | ExitCode> {
  const choosing = connectPickOnly(argv);
  if (choosing && modelsInteractive(context)) return connectByChoice(choosing, context);
  const parsed = parse(argv), env = context.env ?? process.env, locale = commandLocale(context, parsed.values.get('--lang'));
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (parsed.help) { emit(`${t('cli.help.modelsConnect', { kinds: ((context as { providerConnect?: ConnectKinds }).providerConnect?.kinds ?? []).filter(kind => kind.available && kind.connectFamily).map(kind => kind.id).join(', ') || t('cli.help.modelsConnect.kindsFromProvider', {}, locale) }, locale)}\n${t('headless.help.connect', {}, locale)}`, sinks); return; }
  if (!context.connectModel) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const value = (flag: string) => parsed.values.get(flag), exact = value('--reference') ? REFERENCE.exec(value('--reference')!) : null;
  if (value('--reference') && !exact) throw ErrorRegistry.createError('CLI_USAGE');
  const delegate = value('--delegate'), cli = { ...(value('--executable') ? { executable: value('--executable') } : {}), ...(value('--config-dir') ? { configDir: value('--config-dir') } : {}) };
  if (delegate !== undefined && !/^(none|ai|system|ai,system|system,ai)$/u.test(delegate)) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), configured = await loadConfig(root, { env, heal: false }).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  const scope = await resolveCommandScope({ command: 'deckent models connect', locale, explicit: value('--scope'), configured: typeof configured === 'string' ? configured : undefined, mutating: true,
    interactive: modelsInteractive(context, parsed.json), listScopes: () => scopeLister(context as never, root, { env })().catch(() => []), pick: request => askModelsCard(context, locale, request) });
  if (!scope) { reportModelsCancelled(context, locale); return EXIT_CODES.error; }
  const command = modelConnectCommandSchema.safeParse({ schemaVersion: 1, commandId: value('--command-id') ?? `connect-${randomUUID()}`, scopeId: scope.scopeId, connection: value('--connection'),
    ...(Object.keys(cli).length ? { cli } : {}), ...(delegate === undefined ? {} : { delegate: delegate === 'none' ? [] : delegate.split(',') }),
    endpoint: value('--endpoint') ?? null, model: exact ? { reference: { providerId: exact[1], providerVersion: Number(exact[2]), modelId: exact[3], modelVersion: Number(exact[4]) } }
      : value('--model') ? { nativeId: value('--model') } : { pull: 'available' } });
  if (!command.success) throw ErrorRegistry.createError('MODEL_CONNECT_INVALID');
  emit(await context.connectModel(root, command.data, { env }), { ...sinks, json: parsed.json, render: item => renderModelConnect(item, locale, command.data) });
}

/** The connection kinds and their seeded models the host binds for the terminal's `/provider` window (registry data, exact ids). */
type ConnectKinds = Readonly<{ kinds: readonly Readonly<{ id: string; labelKey: string; available: boolean; seeded?: boolean; pull?: 'available' | 'pick'; connectFamily?: string | null }>[];
  seedModels?(kind: string): Promise<readonly Readonly<{ nativeId: string; displayName: string }>[]> }>;
function connectPickOnly(argv: readonly string[]): { scope?: string; language?: string } | null {
  const picked: { scope?: string; language?: string } = {};
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1], key = flag === '--scope' ? 'scope' : flag === '--lang' ? 'language' : null;
    if (!key || !value || value.startsWith('-') || picked[key] !== undefined) return null;
    picked[key] = value;
  }
  return picked;
}

/**
 * A person connects a model (owner CLI review 2026-10-19): the scope, the connection from the provider-connect registry (seeded kinds; an address
 * or a key is entered in the terminal's `/provider` window, never here), the exact model id from its packaged catalog seed (never an alias), then
 * a scoped card. The command is the same typed `models.connect`; a missing key is reported by name with the command that stores it.
 */
async function connectByChoice(picked: { scope?: string; language?: string }, context: ModelCommandContext): Promise<void | ExitCode> {
  const locale = commandLocale(context, picked.language), root = context.root ?? process.cwd(), options: ConfigLoadOptions = { env: context.env ?? process.env };
  const host = (context as { providerConnect?: ConnectKinds }).providerConnect;
  if (!context.connectModel || !host?.seedModels) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const cancelled = () => { reportModelsCancelled(context, locale); return EXIT_CODES.error; };
  const configured = await loadConfig(root, { ...options, heal: false }).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  const scope = await resolveCommandScope({ command: 'deckent models connect', locale, explicit: picked.scope, configured: typeof configured === 'string' ? configured : undefined,
    mutating: true, interactive: true, listScopes: () => scopeLister(context as never, root, options)().catch(() => []), pick: request => askModelsCard(context, locale, request) });
  if (!scope) return cancelled();
  const catalog = MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>;
  const kinds = host.kinds.filter(kind => kind.available && kind.seeded && kind.connectFamily);
  if (!kinds.length) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const kindId = await askModelsCard(context, locale, { title: t('climodels.models.pick.connection', {}, locale), body: [t('climodels.models.pick.connectionBody', {}, locale)],
    options: kinds.map(kind => ({ id: kind.id, label: catalog[kind.labelKey] ?? kind.id })), initial: kinds[0]!.id }); // M-27: the cursor starts on a row, so the first Down moves
  const kind = kinds.find(entry => entry.id === kindId);
  if (!kind) return cancelled();
  const models = await host.seedModels(kind.id);
  if (!models.length) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const pull = kind.pull === 'available';
  const nativeId = pull ? '' : await askModelsCard(context, locale, { title: t('climodels.models.pick.model', { provider: catalog[kind.labelKey] ?? kind.id }, locale), initial: models[0]!.nativeId,
    options: models.map(model => ({ id: model.nativeId, label: model.displayName && model.displayName !== model.nativeId
      ? `${terminalSafeText(model.nativeId)} · ${terminalSafeText(model.displayName)}` : terminalSafeText(model.nativeId) })) });
  if (nativeId === null || !pull && !models.some(model => model.nativeId === nativeId)) return cancelled();
  const answer = await askModelsCard(context, locale, { title: pull ? t('climodels.models.card.connectAll', {}, locale) : t('climodels.models.card.connect', { model: terminalSafeText(nativeId) }, locale), // M-27: no "Connect Connect"
    body: [t('climodels.models.card.where', { scope: terminalSafeText(scope.scopeId), provider: catalog[kind.labelKey] ?? kind.id }, locale), t('climodels.models.card.connectWhat', {}, locale)],
    options: modelsConfirmOptions(locale) });
  if (answer !== 'apply') return cancelled();
  const command = modelConnectCommandSchema.parse({ schemaVersion: 1, commandId: `connect-${randomUUID()}`, scopeId: scope.scopeId, connection: kind.id, endpoint: null, model: pull ? { pull: 'available' } : { nativeId } });
  emit(scopeNotice(scope, locale), modelsSinks(context));
  const result = await context.connectModel(root, command, options);
  emit(result, { ...modelsSinks(context), render: item => [renderModelConnect(item, locale, command),
    ...(item.credentialRef && item.keyStored === false ? [t('climodels.models.connect.storeKey', { name: terminalSafeText(item.credentialRef) }, locale)] : [])].join('\n') });
}
