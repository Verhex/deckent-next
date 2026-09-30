import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { modelCatalogCommandSchema, modelCatalogQuerySchema, type ModelCatalogCommand, type ModelCatalogQuery } from '#domain/index.js';
import type { ModelCatalogInspection, ModelCatalogResult } from '#engine/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import type { ModelCommandContext } from './context.js';

export type ModelCatalogInspectionHandler = (root: string, query: ModelCatalogQuery, options: ConfigLoadOptions) => Promise<ModelCatalogInspection>;
export type ModelCatalogApplyHandler = (root: string, command: ModelCatalogCommand, options: ConfigLoadOptions) => Promise<ModelCatalogResult>;
const INPUT_ERRORS = { limit: 'CLI_CATALOG_INPUT_LIMIT', invalid: 'CLI_CATALOG_INPUT_INVALID', tty: 'CLI_CATALOG_INPUT_TTY', unavailable: 'CLI_CATALOG_INPUT_UNAVAILABLE' } as const;
/** A packaged catalog document shipped with the product (`assets/model-catalog/<name>.json`); an unknown name cannot be read. */
const packagedCatalog = (name: string) => fileURLToPath(new URL(`../../../../../assets/model-catalog/${name}.json`, import.meta.url));

type Action = 'list' | 'register' | 'activate' | 'deactivate';
const FLAGS: Readonly<Record<Action, readonly string[]>> = {
  list: ['--scope', '--channel'], register: ['--scope', '--command-id', '--seed', '--file'],
  activate: ['--scope', '--channel', '--model', '--command-id', '--expected-revision'],
  deactivate: ['--scope', '--channel', '--model', '--command-id', '--expected-revision'],
};
function parse(argv: readonly string[]) {
  const action = argv[2] as Action, help = argv[2] === '--help' || argv[2] === '-h';
  if (!help && !(action in FLAGS)) throw ErrorRegistry.createError('CLI_USAGE');
  const values = new Map<string, string>(); let json = false, language: string | undefined;
  for (let index = 3; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--no-color') continue;
    if (flag !== '--lang' && (help || !FLAGS[action].includes(flag) || values.has(flag))) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++index]; if (!value || (value.startsWith('-') && value !== '-')) throw ErrorRegistry.createError('CLI_USAGE');
    if (flag === '--lang') language = value; else values.set(flag, value);
  }
  if (help) return { help, action, values, json, language };
  const need = (flag: string) => { if (!values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE'); };
  need('--scope');
  if (action !== 'list') need('--command-id');
  if (action === 'register' && values.has('--seed') === values.has('--file')) throw ErrorRegistry.createError('CLI_USAGE');
  if (action === 'activate' || action === 'deactivate') {
    need('--channel'); need('--expected-revision');
    if (!/^(0|[1-9][0-9]*)$/.test(values.get('--expected-revision')!) || !Number.isSafeInteger(Number(values.get('--expected-revision')))) throw ErrorRegistry.createError('CLI_USAGE');
  }
  return { help, action, values, json, language };
}
const activation = (value: { state: string } | null, locale: Locale) => value?.state === 'active' ? t('models.catalog.active', {}, locale) : t('models.catalog.inactive', {}, locale);
function renderList(value: ModelCatalogInspection, locale: Locale): string {
  const lines = [t('models.catalog.heading', { scope: value.scopeId, count: value.channels.length }, locale)];
  for (const channel of value.channels) {
    if (channel.access === 'denied') { lines.push(t('models.catalog.channelDenied', { channel: channel.channelId }, locale)); continue; }
    lines.push(t('models.catalog.channel', { channel: channel.channelId, kind: channel.channel.kind, cli: channel.channel.cli ?? '—', revision: channel.revision,
      catalog: channel.catalogRevision, state: activation(channel.activation, locale) }, locale));
    for (const entry of channel.models) {
      const { lifecycle } = entry.model;
      lines.push(t('models.catalog.model', { model: entry.modelId, lifecycle: lifecycle.state, retire: lifecycle.retiredOn ?? lifecycle.retireNotBefore ?? '—',
        cli: entry.model.minCliVersion ?? '—', efforts: entry.model.efforts.join(',') || '—', aliases: entry.model.aliases.join(',') || '—',
        state: activation(entry.activation, locale) }, locale));
    }
  }
  return [...lines, t('models.catalog.notice', {}, locale)].join('\n');
}
function renderResult(value: ModelCatalogResult, locale: Locale): string {
  const receipt = value.receipt;
  return [t('models.catalog.receipt', { replay: value.replayed ? t('models.activation.replayed', {}, locale) : t('models.activation.admitted', {}, locale),
    command: receipt.command.commandId, action: receipt.command.action, scope: receipt.command.scopeId, level: receipt.authorizations[0]!.level,
    changes: receipt.changes.map(change => `${change.kind}:${change.channelId}${change.modelId ? '/' + change.modelId : ''}@${change.revision}`).join(', ')
      || t('models.catalog.noChanges', {}, locale) }, locale), t('models.catalog.notice', {}, locale)].join('\n');
}

/** `models catalog list|register|activate|deactivate` (WORKER-CURRENCY-2): the same application contract as SDK `applyModelCatalog` and MCP. */
export async function modelCatalogCommand(argv: readonly string[], context: ModelCommandContext): Promise<void> {
  const parsed = parse(argv), env = context.env ?? process.env, locale = resolveLocale(parsed.language, env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (parsed.help) { emit(t('cli.help.modelsCatalog', {}, locale), sinks); return; }
  const root = context.root ?? process.cwd(), options: ConfigLoadOptions = { env }, value = (flag: string) => parsed.values.get(flag);
  if (parsed.action === 'list') {
    if (!context.inspectModelCatalog) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const query = modelCatalogQuerySchema.safeParse({ schemaVersion: 1, scopeId: value('--scope'), ...(value('--channel') ? { channelId: value('--channel') } : {}) });
    if (!query.success) throw ErrorRegistry.createError('CLI_USAGE');
    emit(await context.inspectModelCatalog(root, query.data, options), { ...sinks, json: parsed.json, render: item => renderList(item, locale) });
    return;
  }
  if (!context.applyModelCatalog) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  let catalog: unknown;
  if (parsed.action === 'register') {
    const seed = value('--seed'), source = value('--file'), config = await loadConfig(root, options);
    if (seed !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(seed)) throw ErrorRegistry.createError('CLI_USAGE');
    catalog = await readJsonInput(seed !== undefined ? packagedCatalog(seed) : source === '-' ? source : resolve(root, source!), config.cli.invocationInputMaxBytes, INPUT_ERRORS, context.stdin);
  }
  const command = modelCatalogCommandSchema.safeParse({ schemaVersion: 1, commandId: value('--command-id'), scopeId: value('--scope'), action: parsed.action,
    ...(parsed.action === 'register' ? { catalog } : { channelId: value('--channel'), modelId: value('--model') ?? null, expectedRevision: Number(value('--expected-revision')) }) });
  // An invalid catalog document is the command's typed refusal, not a usage error.
  if (!command.success) throw parsed.action === 'register' ? ErrorRegistry.createError('MODEL_CATALOG_INVALID') : ErrorRegistry.createError('CLI_USAGE');
  emit(await context.applyModelCatalog(root, command.data, options), { ...sinks, json: parsed.json, render: item => renderResult(item, locale) });
}
