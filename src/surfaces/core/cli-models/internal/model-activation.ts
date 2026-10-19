import { randomUUID } from 'node:crypto';
import { ErrorRegistry, EXIT_CODES, emit, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { resolveCommandScope, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import { modelActivationCommandSchema, modelActivationQuerySchema, parseModelReference,
  type ModelActivationCommand, type ModelActivationQuery } from '#domain/index.js';
import type { ModelActivationInspection, ModelActivationResult } from '#engine/index.js';
import type { ModelCommandContext } from './context.js';
import { askModelsCard, explainActivationDenial, modelsConfirmOptions, modelsInteractive, modelsSinks, reportModelsCancelled } from './io.js';

export type ModelActivationInspectionHandler = (root: string, query: ModelActivationQuery,
  options: ConfigLoadOptions) => Promise<ModelActivationInspection>;
export type ModelActivationAdmissionHandler = (root: string, command: ModelActivationCommand,
  options: ConfigLoadOptions) => Promise<ModelActivationResult>;

type Action = 'activation' | 'activate' | 'deactivate';
interface Parsed {
  readonly action: Action; readonly json: boolean; readonly noColor: boolean; readonly help: boolean; readonly language?: string;
  readonly scopeId?: string; readonly providerId?: string; readonly providerVersion?: number; readonly modelId?: string; readonly modelVersion?: number;
  readonly commandId?: string; readonly expectedRevision?: number; readonly bindingDigest?: string; readonly catalogRevision?: string;
}
const referenceFlags = ['--provider', '--provider-version', '--model', '--model-version'] as const;
const commonFlags = ['--scope', ...referenceFlags] as const;
function value(argv: readonly string[], index: number): string {
  const supplied = argv[index];
  if (!supplied || supplied.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
  return supplied;
}
function positiveVersion(input: string): number {
  if (!/^[1-9]\d*$/.test(input)) throw ErrorRegistry.createError('CLI_USAGE');
  const parsed = Number(input); if (!Number.isSafeInteger(parsed)) throw ErrorRegistry.createError('CLI_USAGE'); return parsed;
}
function counter(input: string): number {
  if (!/^(0|[1-9]\d*)$/.test(input)) throw ErrorRegistry.createError('CLI_USAGE');
  const parsed = Number(input); if (!Number.isSafeInteger(parsed)) throw ErrorRegistry.createError('CLI_USAGE'); return parsed;
}
function parse(argv: readonly string[]): Parsed {
  const action = argv[1] as Action;
  if (!['activation', 'activate', 'deactivate'].includes(action)) throw ErrorRegistry.createError('CLI_USAGE');
  const result: { action: Action; json: boolean; noColor: boolean; help: boolean; language?: string;
    scopeId?: string; providerId?: string; providerVersion?: number; modelId?: string; modelVersion?: number;
    commandId?: string; expectedRevision?: number; bindingDigest?: string; catalogRevision?: string } =
    { action, json: false, noColor: false, help: false };
  const seen = new Set<string>();
  const mutation = action !== 'activation';
  const allowed = new Set<string>([...commonFlags, '--json', '--no-color', '--help', '-h', '--lang',
    ...(mutation ? ['--command-id', '--expected-revision', '--binding-digest'] : []),
    ...(action === 'activate' ? ['--catalog-revision'] : [])]);
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!allowed.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const key = flag === '-h' ? '--help' : flag;
    if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(key);
    if (key === '--json') { result.json = true; continue; }
    if (key === '--no-color') { result.noColor = true; continue; }
    if (key === '--help') { result.help = true; continue; }
    const supplied = value(argv, ++index);
    if (key === '--lang') result.language = supplied;
    else if (key === '--scope') result.scopeId = supplied;
    else if (key === '--provider') result.providerId = supplied;
    else if (key === '--provider-version') result.providerVersion = positiveVersion(supplied);
    else if (key === '--model') result.modelId = supplied;
    else if (key === '--model-version') result.modelVersion = positiveVersion(supplied);
    else if (key === '--command-id') result.commandId = supplied;
    else if (key === '--expected-revision') result.expectedRevision = counter(supplied);
    else if (key === '--binding-digest') {
      if (!/^[a-f0-9]{64}$/.test(supplied)) throw ErrorRegistry.createError('CLI_USAGE');
      result.bindingDigest = supplied;
    } else if (key === '--catalog-revision') result.catalogRevision = supplied;
  }
  if (result.help && (result.json || result.noColor)) throw ErrorRegistry.createError('CLI_USAGE');
  if (!result.help) {
    if (!result.scopeId || !result.providerId || result.providerVersion === undefined || !result.modelId || result.modelVersion === undefined) {
      throw ErrorRegistry.createError('CLI_USAGE');
    }
    if (mutation && (!result.commandId || result.expectedRevision === undefined || !result.bindingDigest
      || (action === 'activate' && !result.catalogRevision))) throw ErrorRegistry.createError('CLI_USAGE');
  }
  return result;
}
function reference(parsed: Parsed) {
  try { return parseModelReference({ providerId: parsed.providerId, providerVersion: parsed.providerVersion,
    modelId: parsed.modelId, modelVersion: parsed.modelVersion }); }
  catch { throw ErrorRegistry.createError('CLI_USAGE'); }
}
function label(reference: ModelActivationInspection['reference']): string {
  return `${reference.providerId}@${reference.providerVersion}/${reference.modelId}@${reference.modelVersion}`;
}
function stateLabel(state: 'active' | 'inactive', locale: Locale): string {
  return state === 'active' ? t('models.activation.active', {}, locale) : t('models.activation.inactive', {}, locale);
}
function replayLabel(replayed: boolean, locale: Locale): string {
  return replayed ? t('models.activation.replayed', {}, locale) : t('models.activation.admitted', {}, locale);
}
function renderInspection(value: ModelActivationInspection, locale: Locale): string {
  const ref = label(value.reference);
  const notice = t('models.activation.notice', {}, locale);
  if (value.activation === null) return [t('models.activation.absent', { reference: ref, scope: value.scopeId }, locale), notice].join('\n');
  return [t('models.activation.persisted', { reference: ref, scope: value.scopeId, revision: value.activation.revision,
    state: stateLabel(value.activation.state, locale) }, locale), notice].join('\n');
}
function renderAdmission(value: ModelActivationResult, locale: Locale): string {
  const receipt = value.receipt, ref = label(receipt.record.reference);
  return [t('models.activation.receipt', { command: receipt.command.commandId, reference: ref, scope: receipt.command.scopeId,
    revision: receipt.record.revision, state: stateLabel(receipt.record.state, locale), replay: replayLabel(value.replayed, locale) }, locale),
  t('models.activation.notice', {}, locale)].join('\n');
}

/** Exact durable activation state only; this command never infers provider reachability or execution readiness. */
export async function modelActivationCommand(argv: readonly string[], context: ModelCommandContext): Promise<void | ExitCode> {
  const picked = pickOnly(argv);
  if (picked && argv[1] !== 'activation' && modelsInteractive(context)) return activationByChoice(argv[1] as 'activate' | 'deactivate', picked, context);
  const parsed = parse(argv), locale = commandLocale(context, parsed.language);
  const sinks = modelsSinks(context);
  if (parsed.help) { emit(t('cli.help.modelsActivation', {}, locale), sinks); return; }
  const model = reference(parsed), root = context.root ?? process.cwd(), options: ConfigLoadOptions = { env: context.env ?? process.env };
  if (parsed.action === 'activation') {
    if (!context.inspectModelActivation) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const query = modelActivationQuerySchema.safeParse({ schemaVersion: 1, scopeId: parsed.scopeId, reference: model });
    if (!query.success) throw ErrorRegistry.createError('CLI_USAGE');
    const result = await context.inspectModelActivation(root, query.data, options);
    emit(result, { ...sinks, json: parsed.json, render: item => renderInspection(item, locale) });
    return;
  }
  if (!context.admitModelActivation) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const command = modelActivationCommandSchema.safeParse({ schemaVersion: 1, action: parsed.action, scopeId: parsed.scopeId,
    commandId: parsed.commandId, reference: model, expectedRevision: parsed.expectedRevision,
    expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: parsed.bindingDigest },
    ...(parsed.action === 'activate' ? { catalogRevision: parsed.catalogRevision } : {}) });
  if (!command.success) throw ErrorRegistry.createError('CLI_USAGE');
  const result = await context.admitModelActivation(root, command.data, options);
  emit(result, { ...sinks, json: parsed.json, render: item => renderAdmission(item, locale) });
}

/** `models activate|deactivate` with at most `--scope`/`--lang`: the values a person picks on a terminal (owner CLI review 2026-10-19). */
function pickOnly(argv: readonly string[]): { scope?: string; language?: string } | null {
  const picked: { scope?: string; language?: string } = {};
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if ((flag !== '--scope' && flag !== '--lang') || !value || value.startsWith('-') || (flag === '--scope' ? picked.scope : picked.language) !== undefined) return null;
    if (flag === '--scope') picked.scope = value; else picked.language = value;
  }
  return picked;
}

/**
 * A person's activation (owner CLI review 2026-10-19): the scope (never a silent default for a change), the provider and the exact model id from
 * the declared catalog (never an alias), then the system reads the binding digest, catalog revision and current activation revision, and a
 * scoped card confirms. The command is the same typed `models activate|deactivate` the long AI form sends; nothing is written before the card.
 */
async function activationByChoice(action: 'activate' | 'deactivate', picked: { scope?: string; language?: string }, context: ModelCommandContext): Promise<void | ExitCode> {
  const locale = commandLocale(context, picked.language), root = context.root ?? process.cwd(), options: ConfigLoadOptions = { env: context.env ?? process.env };
  if (!context.inspectDeclaredModels || !context.inspectModelBinding || !context.inspectModelActivation || !context.admitModelActivation) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const cancelled = () => { reportModelsCancelled(context, locale); return EXIT_CODES.error; };
  const configured = await loadConfig(root, { ...options, heal: false }).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  const scope = await resolveCommandScope({ command: `deckent models ${action}`, locale, explicit: picked.scope, configured: typeof configured === 'string' ? configured : undefined,
    mutating: true, interactive: true, listScopes: () => scopeLister(context as never, root, options)().catch(() => []), pick: request => askModelsCard(context, locale, request) });
  if (!scope) return cancelled();
  const declared = await context.inspectDeclaredModels(root, options);
  if (declared.status !== 'declared' || !declared.catalog.providers.some(provider => provider.models.length)) {
    emit(t('climodels.models.pick.noneDeclared', {}, locale), { level: 'warning', ...modelsSinks(context) }); return EXIT_CODES.usage;
  }
  const providers = declared.catalog.providers.filter(provider => provider.models.length);
  const providerId = await askModelsCard(context, locale, { title: t('climodels.models.pick.provider', {}, locale),
    options: providers.map(provider => ({ id: `${provider.id}@${provider.version}`, label: terminalSafeText(provider.id) })) });
  const provider = providers.find(entry => `${entry.id}@${entry.version}` === providerId);
  if (!provider) return cancelled();
  // Exact ids only (owner 2026-10-08): the declared native id is what the person reads and picks; aliases are never offered.
  const modelId = await askModelsCard(context, locale, { title: t('climodels.models.pick.model', { provider: terminalSafeText(provider.id) }, locale),
    options: provider.models.map(model => ({ id: `${model.id}@${model.version}`, label: terminalSafeText(model.nativeId) })) });
  const model = provider.models.find(entry => `${entry.id}@${entry.version}` === modelId);
  if (!model) return cancelled();
  const ref = { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version };
  const binding = await context.inspectModelBinding(root, parseModelReference(ref), options);
  if (binding.status !== 'declared') throw ErrorRegistry.createError('MODEL_ACTIVATION_NOT_FOUND');
  const current = await context.inspectModelActivation(root, { schemaVersion: 1, scopeId: scope.scopeId, reference: ref }, options);
  const shown = { model: terminalSafeText(model.nativeId) };
  const answer = await askModelsCard(context, locale, { title: action === 'activate' ? t('climodels.models.card.activate', shown, locale) : t('climodels.models.card.deactivate', shown, locale),
    body: [t('climodels.models.card.where', { scope: terminalSafeText(scope.scopeId), provider: terminalSafeText(provider.id) }, locale),
      t('climodels.models.card.now', { state: current.activation ? stateLabel(current.activation.state, locale) : t('models.activation.inactive', {}, locale) }, locale),
      t('climodels.models.card.system', {}, locale)], options: modelsConfirmOptions(locale) });
  if (answer !== 'apply') return cancelled();
  const command = modelActivationCommandSchema.parse({ schemaVersion: 1, action, scopeId: scope.scopeId, commandId: `models-${randomUUID()}`, reference: ref,
    expectedRevision: current.activation?.revision ?? 0, expectedBinding: binding.binding, ...(action === 'activate' ? { catalogRevision: binding.catalogRevision } : {}) });
  emit(scopeNotice(scope, locale), modelsSinks(context));
  const result = await context.admitModelActivation(root, command, options).catch(error => explainActivationDenial(error, context, locale, action, scope.scopeId));
  emit(result, { ...modelsSinks(context), render: item => renderAdmission(item, locale) });
}
