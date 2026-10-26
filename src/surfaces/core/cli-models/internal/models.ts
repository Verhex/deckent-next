import { siwcCliCommand } from '#surfaces/core/siwc/index.js';
import { ErrorRegistry, emit, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import { parseModelReference } from '#domain/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliTableStyle, renderCliTable, resolveCommandScope, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import type { ModelCommandContext } from './context.js';
import { modelInvocationCommand } from './model-invocation.js';
import { modelActivationCommand } from './model-activation.js';
import { modelSpendingCommand } from './model-spending.js';
import { modelCatalogCommand } from './model-catalog.js';
import { modelConnectCommand } from './model-connect.js';
import { modelLoginCommand } from './model-login.js';
import { modelRolesCommand } from './model-roles.js';
import { renderModelsTable } from './models-table.js';
import { modelsInteractive, retirementWarningDays } from './io.js';

interface Parsed { action: 'list' | 'binding'; json: boolean; noColor: boolean; help: boolean; language?: string; declared: boolean; catalog: boolean; verbose: boolean; scopeId?: string;
  providerId?: string; providerVersion?: number; modelId?: string; modelVersion?: number }
function positiveVersion(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) throw ErrorRegistry.createError('CLI_USAGE');
  const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw ErrorRegistry.createError('CLI_USAGE'); return parsed;
}
function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'models') throw ErrorRegistry.createError('CLI_USAGE');
  const action = argv[1] === 'binding' ? 'binding' : 'list';
  const parsed: Parsed = { action, json: false, noColor: false, help: false, declared: false, catalog: false, verbose: false }; const seen = new Set<string>();
  for (let index = action === 'binding' ? 2 : 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === '--json' || value === '--no-color' || value === '--help' || value === '-h' || (action === 'list' && (value === '--declared' || value === '--catalog' || value === '--verbose'))) {
      const key = value === '-h' ? '--help' : value; if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(key);
      if (key === '--json') parsed.json = true; else if (key === '--no-color') parsed.noColor = true; else if (key === '--declared') parsed.declared = true;
      else if (key === '--catalog') parsed.catalog = true;
      else if (key === '--verbose') parsed.verbose = true; else parsed.help = true;
    } else if (value === '--lang' || (action === 'list' && value === '--scope')) {
      if (seen.has(value)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(value); const supplied = argv[++index];
      if (!supplied || supplied.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (value === '--lang') parsed.language = supplied; else parsed.scopeId = supplied;
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
  if (parsed.declared && (parsed.scopeId || parsed.catalog)) throw ErrorRegistry.createError('CLI_USAGE');
  // Lead J2e (C-MODELS decision 2): plain `models --json` keeps the declared-list contract scripts and AI read; the catalog JSON needs `--catalog`
  // (or `--scope`, which only the catalog takes).
  if (action === 'list' && parsed.json && !parsed.catalog && !parsed.scopeId) parsed.declared = true;
  if (action === 'binding' && !parsed.help && (!parsed.providerId || parsed.providerVersion === undefined
    || !parsed.modelId || parsed.modelVersion === undefined)) throw ErrorRegistry.createError('CLI_USAGE');
  return parsed;
}
/** `--declared`: what the connected providers declare (the chat catalog), one row per exact model id; protocol detail only with --verbose. */
function render(result: import('#engine/index.js').DeclaredModelsInspection, locale: Locale, verbose: boolean, context: ModelCommandContext): string {
  if (result.status === 'not-configured') return t('models.notConfigured', {}, locale);
  if (verbose) {
    const rows = result.catalog.providers.flatMap(provider => provider.models.map(model => t('models.declaredRow', {
      provider: provider.id, providerVersion: provider.version, model: model.id, modelVersion: model.version, nativeId: model.nativeId,
      protocols: model.protocols.map(protocol => `${protocol.family}@${protocol.version}[${protocol.capabilities.map(capability =>
        `${capability.id}@${capability.version}:${capability.state}`).join(',')}]`).join(';'),
    }, locale)));
    return [t('models.declaredHeader', { revision: result.catalog.revision }, locale), ...rows, t('models.availabilityNotObserved', {}, locale)].join('\n');
  }
  const rows = result.catalog.providers.flatMap(provider => provider.models.map(model => [terminalSafeText(model.nativeId), terminalSafeText(provider.id),
    [...new Set(model.protocols.map(protocol => terminalSafeText(protocol.family)))].join(', ')]));
  return [t('climodels.models.declared.heading', {}, locale), renderCliTable([{ header: t('climodels.models.table.model', {}, locale), shrink: false },
    { header: t('climodels.models.table.provider', {}, locale) }, { header: t('climodels.models.table.protocol', {}, locale) }], rows, cliTableStyle(context)),
  '', t('climodels.models.declared.footer', {}, locale)].join('\n');
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

export async function modelsCommand(argv: readonly string[], context: ModelCommandContext): Promise<void | ExitCode> {
  if (argv[1] === 'spending' || argv[1] === 'audit-spending' || argv[1] === 'reconcile-spending' || argv[1] === 'revise-budget' || argv[1] === 'create-budget') return modelSpendingCommand(argv, context);
  if (argv[1] === 'invoke' || argv[1] === 'invocation' || argv[1] === 'purge-content' || argv[1] === 'cancel') return modelInvocationCommand(argv, context);
  if (argv[1] === 'activation' || argv[1] === 'activate' || argv[1] === 'deactivate') return modelActivationCommand(argv, context);
  // WORKER-CURRENCY-2: the ledger model catalog; `models catalog activate` never reaches the chat activation command above.
  if (argv[1] === 'catalog') return modelCatalogCommand(argv, context);
  if (context.siwc && ['connect', 'login', 'logout'].includes(argv[1] ?? '') && argv[argv.indexOf('--connection') + 1] === context.siwc.connection) return siwcCliCommand(argv, context, context.siwc.execute);
  if (argv[1] === 'connect') return modelConnectCommand(argv, context);
  if (argv[1] === 'login') return modelLoginCommand(argv, context);
  // M2: which exact catalog model serves which role; `set` is a person's card.
  if (argv[1] === 'roles') return modelRolesCommand(argv, context);
  const parsed = parse(argv), env = context.env ?? process.env, locale = commandLocale(context, parsed.language);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (parsed.help) { emit(parsed.action === 'binding' ? t('cli.help.modelsBinding', {}, locale) : t('cli.help.models', {}, locale), sinks); return; }
  const options: ConfigLoadOptions = { env }, root = context.root ?? process.cwd();
  if (parsed.action === 'binding') {
    if (!context.inspectModelBinding) throw ErrorRegistry.createError('CLI_USAGE');
    let reference;
    try { reference = parseModelReference({ providerId: parsed.providerId, providerVersion: parsed.providerVersion, modelId: parsed.modelId, modelVersion: parsed.modelVersion }); }
    catch { throw ErrorRegistry.createError('CLI_USAGE'); }
    emit(await context.inspectModelBinding(root, reference, options), { ...sinks, json: parsed.json, render: value => renderBinding(value, locale) });
    return;
  }
  if (parsed.declared) {
    if (!context.inspectDeclaredModels) throw ErrorRegistry.createError('CLI_USAGE');
    emit(await context.inspectDeclaredModels(root, options), { ...sinks, json: parsed.json, render: value => render(value, locale, parsed.verbose, context) });
    return;
  }
  // Owner CLI review 2026-10-19: bare `models` is the scope's worker catalog as one table (a read: the configured scope, and it says so).
  if (!context.inspectModelCatalog) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const configured = await loadConfig(root, { ...options, heal: false }).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  const scope = await resolveCommandScope({ command: 'deckent models', locale, explicit: parsed.scopeId, configured: typeof configured === 'string' ? configured : undefined,
    mutating: false, interactive: modelsInteractive(context, parsed.json), listScopes: () => scopeLister(context as never, root, options)().catch(() => []) });
  if (!scope) return;
  const inspection = await context.inspectModelCatalog(root, { schemaVersion: 1, scopeId: scope.scopeId }, options);
  const warnDays = parsed.json ? 0 : await retirementWarningDays(context);
  if (!parsed.json) emit(scopeNotice(scope, locale), sinks);
  emit(inspection, { ...sinks, json: parsed.json, render: value => renderModelsTable(value, { locale, nowMs: Date.now(), warnDays, verbose: parsed.verbose, style: cliTableStyle(context) }) });
}
