import { ErrorRegistry, emit, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { modelConnectCommandSchema, type ModelConnectCommand, type ModelConnectResult } from '#domain/index.js';
import type { ModelCommandContext } from './context.js';

export type ModelConnectHandler = (root: string, command: ModelConnectCommand, options: ConfigLoadOptions) => Promise<ModelConnectResult>;
const FLAGS = ['--scope', '--connection', '--endpoint', '--model', '--reference', '--command-id', '--lang'] as const;
/** `provider@version/model@version`: the exact catalog reference the terminal and `models binding` show. */
const REFERENCE = /^([^@/\s]+)@([1-9]\d*)\/([^@/\s]+)@([1-9]\d*)$/u;

function parse(argv: readonly string[]) {
  const values = new Map<string, string>(); let json = false, help = false;
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index]!;
    if ((flag === '--json' && !json)) { json = true; continue; }
    if (flag === '--no-color') continue;
    if ((flag === '--help' || flag === '-h') && !help) { help = true; continue; }
    if (!(FLAGS as readonly string[]).includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++index]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
    values.set(flag, value);
  }
  if (help) return { help, json, values };
  for (const flag of ['--scope', '--connection', '--command-id']) if (!values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
  if (values.has('--model') === values.has('--reference')) throw ErrorRegistry.createError('CLI_USAGE');
  return { help, json, values };
}
const stepWord = (state: string, locale: Locale) => state === 'written' ? t('models.connect.step.written', {}, locale)
  : state === 'present' ? t('models.connect.step.present', {}, locale) : t('models.connect.step.skipped', {}, locale);
/** The person's summary: what is connected, under which key name, what each governed step did and what (if anything) still waits. */
export function renderModelConnect(result: ModelConnectResult, locale: Locale): string {
  const reference = `${result.reference.providerId}@${result.reference.providerVersion}/${result.reference.modelId}@${result.reference.modelVersion}`;
  const lines = [result.status === 'connected' ? t('models.connect.connected', { reference, scope: result.scopeId }, locale)
    : t('models.connect.pending', { reference, key: result.approval?.keyPath ?? '-', approval: result.approval?.approvalId ?? '-' }, locale),
  t('models.connect.steps', { catalog: stepWord(result.steps.catalog, locale), declaration: stepWord(result.steps.declaration, locale),
    profile: stepWord(result.steps.profile, locale), activation: stepWord(result.steps.activation, locale), carried: result.steps.carried }, locale),
  result.credentialRef === null ? t('models.connect.keyNone', {}, locale) : result.keyStored === false ? t('models.connect.keyMissing', { name: result.credentialRef }, locale)
    : t('models.connect.key', { name: result.credentialRef }, locale)];
  if (result.notCarried.length) lines.push(t('models.connect.notCarried', { models: result.notCarried.map(item => `${item.reference.providerId}@${item.reference.providerVersion}/`
    + `${item.reference.modelId}@${item.reference.modelVersion} (${item.code})`).join(', ') }, locale));
  if (result.tariff === 'unmetered') lines.push(t('models.connect.unmetered', {}, locale));
  if (result.service === 'stale') lines.push(t('models.connect.restart', {}, locale));
  return lines.join('\n');
}

/** `deckent models connect` (T4-B D2): the same `models.connect` application as SDK `connectModel`, MCP `connect_model` and the terminal. */
export async function modelConnectCommand(argv: readonly string[], context: ModelCommandContext): Promise<void> {
  const parsed = parse(argv), env = context.env ?? process.env, locale = resolveLocale(parsed.values.get('--lang'), env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (parsed.help) { emit(t('cli.help.modelsConnect', {}, locale), sinks); return; }
  if (!context.connectModel) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const value = (flag: string) => parsed.values.get(flag), exact = value('--reference') ? REFERENCE.exec(value('--reference')!) : null;
  if (value('--reference') && !exact) throw ErrorRegistry.createError('CLI_USAGE');
  const command = modelConnectCommandSchema.safeParse({ schemaVersion: 1, commandId: value('--command-id'), scopeId: value('--scope'), connection: value('--connection'),
    endpoint: value('--endpoint') ?? null, model: exact ? { reference: { providerId: exact[1], providerVersion: Number(exact[2]), modelId: exact[3], modelVersion: Number(exact[4]) } }
      : { nativeId: value('--model') } });
  if (!command.success) throw ErrorRegistry.createError('MODEL_CONNECT_INVALID');
  emit(await context.connectModel(context.root ?? process.cwd(), command.data, { env }), { ...sinks, json: parsed.json, render: item => renderModelConnect(item, locale) });
}
