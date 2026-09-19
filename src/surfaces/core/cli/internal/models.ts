import { ErrorRegistry, emit, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { CommandContext } from './kernel-commands.js';

interface Parsed { json: boolean; noColor: boolean; help: boolean; language?: string }
function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'models') throw ErrorRegistry.createError('CLI_USAGE');
  const parsed: Parsed = { json: false, noColor: false, help: false }; const seen = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === '--json' || value === '--no-color' || value === '--help' || value === '-h') {
      const key = value === '-h' ? '--help' : value; if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(key);
      if (key === '--json') parsed.json = true; else if (key === '--no-color') parsed.noColor = true; else parsed.help = true;
    } else if (value === '--lang') {
      if (seen.has(value)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(value); const language = argv[++index];
      if (!language || language.startsWith('-') || (language !== 'en' && language !== 'tr')) throw ErrorRegistry.createError('CLI_USAGE');
      parsed.language = language;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (parsed.help && (parsed.json || parsed.noColor)) throw ErrorRegistry.createError('CLI_USAGE');
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

export async function modelsCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const parsed = parse(argv), env = context.env ?? process.env, locale = resolveLocale(parsed.language, env);
  context.onLocale?.(locale);
  if (parsed.help) {
    emit(t('cli.help.models', {}, locale), { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
    return;
  }
  if (!context.inspectDeclaredModels) throw ErrorRegistry.createError('CLI_USAGE');
  const options: ConfigLoadOptions = { env };
  const result = await context.inspectDeclaredModels(context.root ?? process.cwd(), options);
  emit(result, { json: parsed.json, render: value => render(value, locale),
    ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
}
