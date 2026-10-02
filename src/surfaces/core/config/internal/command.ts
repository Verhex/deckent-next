import { randomUUID } from 'node:crypto';
import { ErrorRegistry } from '#platform/index.js';
import { configDisplayView, getConfigValue, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { emit, formatValue } from '#platform/index.js';
import { resolveLocale, t, type Locale } from '#platform/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import type { ConfigApplication } from '#engine/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { applyWord, renderConfigExplanation, renderConfigInspection, sourceWord } from './render.js';

export type ConfigApplicationFactory = (root: string, options: ConfigLoadOptions) => ConfigApplication;
export interface ConfigCommandContext extends CliBaseContext {
  configApplication?: ConfigApplicationFactory;
  resolveConfigPrincipal?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<VerifiedPrincipal>;
}
interface Parsed { readonly args: string[]; json: boolean; global: boolean; help: boolean; language?: string; expect?: string; scope?: string; commandId?: string }
function parse(argv: readonly string[]): Parsed {
  const result: Parsed = { args: [], json: false, global: false, help: false };
  const valued = { '--lang': 'language', '--expect': 'expect', '--scope': 'scope', '--command-id': 'commandId' } as const;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' || arg === '--global' || arg === '--help' || arg === '-h') {
      const key = arg === '--json' ? 'json' : arg === '--global' ? 'global' : 'help'; if (result[key]) throw ErrorRegistry.createError('CLI_USAGE'); result[key] = true;
    } else if (arg === '--no-color') continue;
    else if (Object.hasOwn(valued, arg)) {
      const key = valued[arg as keyof typeof valued], value = argv[++i];
      if (!value || value.startsWith('--') || result[key] !== undefined) throw ErrorRegistry.createError('CLI_USAGE'); result[key] = value;
    } else if (arg.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE');
    else result.args.push(arg);
  }
  return result;
}
export async function configCommand(argv: readonly string[], context: ConfigCommandContext): Promise<void> {
  const parsed = parse(argv), root = context.root ?? process.cwd(), env = context.env ?? process.env;
  let locale = resolveLocale(parsed.language, env); context.onLocale?.(locale);
  const sinks = { json: parsed.json, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const action = parsed.args[0], keyPath = parsed.args[1], isWrite = action === 'set' || action === 'unset';
  const options: ConfigLoadOptions = { env, heal: false, onWarning: warning => emit(warning, { ...sinks, level: 'warning', render: value => value.message }) };
  if (parsed.help) { emit(t('config.surface.help', {}, locale), { ...sinks, json: false }); return; }
  if (!isWrite && (parsed.expect || parsed.scope || parsed.commandId)) throw ErrorRegistry.createError('CLI_USAGE');
  if (action === 'get') {
    if (parsed.args.length > 2) throw ErrorRegistry.createError('CLI_USAGE');
    const config = await loadConfig(root, { ...options, heal: true, globalOnly: parsed.global });
    locale = resolveLocale(parsed.language, env, config.language); context.onLocale?.(locale);
    const display = configDisplayView(config), value = keyPath === undefined ? display : getConfigValue(display, keyPath);
    emit(value, { ...sinks, mode: config.output_mode, render: formatValue }); return;
  }
  if (!context.configApplication) throw ErrorRegistry.createError('CLI_USAGE', { params: { usage: t('config.surface.unavailable', {}, locale) } });
  const app = context.configApplication(root, options), layer = parsed.global ? 'global' as const : 'project' as const;
  if (action === undefined && parsed.args.length === 0) {
    const view = await app.inspect({ layer });
    locale = resolveLocale(parsed.language, env, view.fields.find(field => field.key === 'language')?.value as string | undefined); context.onLocale?.(locale);
    emit(view, { ...sinks, render: value => renderConfigInspection(value, locale) }); return;
  }
  if (action === 'explain' && parsed.global) throw ErrorRegistry.createError('CLI_USAGE');
  if (action === 'explain' && keyPath && parsed.args.length === 2) {
    emit(await app.explain({ keyPath }), { ...sinks, render: value => renderConfigExplanation(value, locale) }); return;
  }
  if (action === 'validate' && parsed.args.length === 1) { emit(await app.validate(), { ...sinks, render: () => t('config.surface.valid', {}, locale) }); return; }
  if (!isWrite || !keyPath || parsed.args.length !== (action === 'set' ? 3 : 2)) throw ErrorRegistry.createError('CLI_USAGE');
  let value: unknown;
  if (action === 'set') { try { value = JSON.parse(parsed.args[2]!); } catch { throw ErrorRegistry.createError('CLI_USAGE'); } }
  const scopeId = parsed.scope ?? ((await loadConfig(root, options))['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  if (!context.resolveConfigPrincipal) throw ErrorRegistry.createError('CLI_USAGE');
  const principal = await context.resolveConfigPrincipal(root, scopeId, options), input = { keyPath, layer, principal, scopeId,
    commandId: parsed.commandId ?? randomUUID(), ...(parsed.expect === undefined ? {} : { expect: parsed.expect === 'absent' ? null : parsed.expect }) };
  const field = await app.explain({ keyPath });
  const result = action === 'set' ? await app.set({ ...input, value }) : await app.unset(input);
  emit(result, { ...sinks, render: () => [t('config.surface.changed', { key: keyPath, layer: sourceWord(layer, locale), apply: applyWord(field.apply, locale), backup: result.backupPath ?? '-' }, locale),
    ...(result.overridden ? [t('config.surface.overridden', {}, locale)] : [])].join('\n') });
}
/** Terminal observation shares the application; this slash view exposes no write route. */
export async function configSlash(root: string, args: string, context: ConfigCommandContext, options: ConfigLoadOptions, locale: Locale, width: number): Promise<readonly string[]> {
  const keyPath = args.trim();
  if (!context.configApplication || /\s/.test(keyPath)) return [t('config.surface.slashUsage', {}, locale)];
  const view = await context.configApplication(root, options).inspect(keyPath ? { keyPath } : {});
  return renderConfigInspection(view, locale, width).split('\n');
}
