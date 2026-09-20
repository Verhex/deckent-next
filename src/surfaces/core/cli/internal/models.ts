import { ErrorRegistry, emit, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { parseModelReference } from '#domain/index.js';
import type { CommandContext } from './kernel-commands.js';
import { modelInvocationCommand } from './model-invocation.js';
import { modelActivationCommand } from './model-activation.js';

interface Parsed { action: 'list' | 'binding'; json: boolean; noColor: boolean; help: boolean; language?: string;
  providerId?: string; providerVersion?: number; modelId?: string; modelVersion?: number }
function positiveVersion(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) throw ErrorRegistry.createError('CLI_USAGE');
  const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw ErrorRegistry.createError('CLI_USAGE'); return parsed;
}
function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'models') throw ErrorRegistry.createError('CLI_USAGE');
  const action = argv[1] === 'binding' ? 'binding' : 'list';
  const parsed: Parsed = { action, json: false, noColor: false, help: false }; const seen = new Set<string>();
  for (let index = action === 'binding' ? 2 : 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === '--json' || value === '--no-color' || value === '--help' || value === '-h') {
      const key = value === '-h' ? '--help' : value; if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(key);
      if (key === '--json') parsed.json = true; else if (key === '--no-color') parsed.noColor = true; else parsed.help = true;
    } else if (value === '--lang') {
      if (seen.has(value)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(value); const language = argv[++index];
      if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      parsed.language = language;
    } else if (action === 'binding' && ['--provider', '--provider-version', '--model', '--model-version'].includes(value)) {
      if (seen.has(value)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(value); const supplied = argv[++index];
      if (!supplied || supplied.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (value === '--provider') parsed.providerId = supplied;
      else if (value === '--provider-version') parsed.providerVersion = positiveVersion(supplied);
      else if (value === '--model') parsed.modelId = supplied;
      else parsed.modelVersion = positiveVersion(supplied);
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (parsed.help && (parsed.json || parsed.noColor)) throw ErrorRegistry.createError('CLI_USAGE');
  if (action === 'binding' && !parsed.help && (!parsed.providerId || parsed.providerVersion === undefined
    || !parsed.modelId || parsed.modelVersion === undefined)) throw ErrorRegistry.createError('CLI_USAGE');
  return parsed;
}
function render(result: import('#engine/index.js').DeclaredModelsInspection, locale: Locale): string {
  if (result.status === 'not-configured') return t('models.notConfigured', {}, locale);
  const rows = result.catalog.providers.flatMap(provider => provider.models.map(model => t('models.declaredRow', {
    provider: provider.id, providerVersion: provider.version, model: model.id, modelVersion: model.version, nativeId: model.nativeId,
    protocols: model.protocols.map(protocol => `${protocol.family}@${protocol.version}[${protocol.capabilities.map(capability =>
      `${capability.id}@${capability.version}:${capability.state}`).join(',')}]`).join(';'),
  }, locale)));
  return [t('models.declaredHeader', { revision: result.catalog.revision }, locale), ...rows,
    t('models.availabilityNotObserved', {}, locale)].join('\n');
}
function renderBinding(result: import('#engine/index.js').ModelBindingInspection, locale: Locale): string {
  const reference = `${result.reference.providerId}@${result.reference.providerVersion}/${result.reference.modelId}@${result.reference.modelVersion}`;
  if (result.status === 'not-configured') return [t('models.bindingNotConfigured', { reference }, locale),
    t('models.availabilityNotObserved', {}, locale)].join('\n');
  if (result.status === 'not-declared') return [t('models.bindingNotDeclared', { reference, revision: result.catalogRevision }, locale),
    t('models.availabilityNotObserved', {}, locale)].join('\n');
  return [t('models.bindingDeclared', { reference, revision: result.catalogRevision,
    nativeId: result.definition.model.nativeId, digest: result.binding.digest }, locale),
  t('models.availabilityNotObserved', {}, locale)].join('\n');
}

export async function modelsCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  if (argv[1] === 'invoke' || argv[1] === 'invocation' || argv[1] === 'purge-content' || argv[1] === 'cancel') return modelInvocationCommand(argv, context);
  if (argv[1] === 'activation' || argv[1] === 'activate' || argv[1] === 'deactivate') return modelActivationCommand(argv, context);
  const parsed = parse(argv), env = context.env ?? process.env, locale = resolveLocale(parsed.language, env);
  context.onLocale?.(locale);
  if (parsed.help) {
    emit(parsed.action === 'binding' ? t('cli.help.modelsBinding', {}, locale) : t('cli.help.models', {}, locale),
      { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
    return;
  }
  const options: ConfigLoadOptions = { env };
  const result = parsed.action === 'binding' ? await (() => {
    if (!context.inspectModelBinding) throw ErrorRegistry.createError('CLI_USAGE');
    let reference;
    try { reference = parseModelReference({ providerId: parsed.providerId, providerVersion: parsed.providerVersion,
      modelId: parsed.modelId, modelVersion: parsed.modelVersion }); }
    catch { throw ErrorRegistry.createError('CLI_USAGE'); }
    return context.inspectModelBinding(context.root ?? process.cwd(), reference, options);
  })() : await (() => {
    if (!context.inspectDeclaredModels) throw ErrorRegistry.createError('CLI_USAGE');
    return context.inspectDeclaredModels(context.root ?? process.cwd(), options);
  })();
  emit(result, { json: parsed.json, render: value => 'reference' in value ? renderBinding(value, locale) : render(value, locale),
    ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
}
