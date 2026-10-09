import { randomUUID } from 'node:crypto';
import { ErrorRegistry } from '#platform/index.js';
import { configDisplayView, getConfigValue, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { emit, formatValue } from '#platform/index.js';
import { resolveLocale, t, type Locale } from '#platform/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import { configServiceState, parseConfigInput, type ConfigApplication, type ConfigChangeOutcome, type DescribeService } from '#engine/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { applyWord, renderConfigExplanation, renderConfigInspection, sourceWord } from './render.js';

export type ConfigApplicationFactory = (root: string, options: ConfigLoadOptions) => ConfigApplication;
export interface ConfigCommandContext extends CliBaseContext {
  configChoiceSources?: (root: string, options: ConfigLoadOptions) => import('./choices.js').ConfigChoiceSourcePort;
  configApplication?: ConfigApplicationFactory;
  loadInstallationIdentity?: (root: string, options: ConfigLoadOptions) => Promise<unknown>;
  /** Read-only service describe: a restart-apply change is compared with what the running service started with. */
  describeRuntimeService?: DescribeService;
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
    // Config owns its bootstrap fence, recovery lock and warnings. Identity observation follows that load,
    // so the dispatcher's non-healing language/identity probe cannot preempt recovery or inspect project for --global.
    await context.loadInstallationIdentity?.(root, { env, heal: false, globalOnly: parsed.global });
    const display = configDisplayView(config), value = keyPath === undefined ? display : getConfigValue(display, keyPath);
    emit(value, { ...sinks, mode: config.output_mode, render: formatValue }); return;
  }
  await context.loadInstallationIdentity?.(root, { env, heal: false, globalOnly: parsed.global });
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
  // T3 L2: a policy `require-approval` opens a config-change approval and writes nothing; the same command (`--command-id`, `--expect`) applies it once allowed.
  const outcome = await app.submit(action, action === 'set' ? { ...input, value } : input);
  if (outcome.status === 'approval-pending') { emit(outcome, { ...sinks, render: () => renderConfigPending(outcome, locale, 'cli').join('\n') }); return; }
  const { result } = outcome;
  // A restart-apply change is compared with the running service's own fingerprint, so "restart" is a measured state, not a standing hint.
  const service = field.apply === 'restart' ? await configServiceState(root, options, context.describeRuntimeService) : null;
  emit({ ...result, ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}), ...(service ? { service } : {}) }, { ...sinks, render: () => renderConfigChanged(keyPath, layer, field.apply, result, service, locale).join('\n') });
}
function renderConfigChanged(keyPath: string, layer: 'project' | 'global', apply: 'live' | 'restart', result: { readonly backupPath: string | null; readonly overridden: boolean },
  service: Awaited<ReturnType<typeof configServiceState>>, locale: Locale): string[] {
  return [t('config.surface.changed', { key: keyPath, layer: sourceWord(layer, locale), apply: applyWord(apply, locale), backup: result.backupPath ?? '-' }, locale),
    ...(result.overridden ? [t('config.surface.overridden', {}, locale)] : []),
    ...(service ? [{ current: t('config.surface.service.current', {}, locale), stale: t('config.surface.service.stale', {}, locale),
      unknown: t('config.surface.service.unknown', {}, locale), stopped: t('config.surface.service.stopped', {}, locale) }[service]] : [])];
}
/** Nothing was written: the card's sentence, where to decide and how the same command applies it (CLI flags or the terminal's own re-run). */
function renderConfigPending(outcome: Extract<ConfigChangeOutcome, { status: 'approval-pending' }>, locale: Locale, surface: 'cli' | 'terminal'): string[] {
  const values = { id: outcome.approval.approvalId, summary: outcome.approval.summary, commandId: outcome.commandId, expect: outcome.expect ?? 'absent' };
  return [t('config.approval.pending', values, locale), surface === 'cli' ? t('config.approval.resubmitCli', values, locale) : t('config.approval.resubmitTerminal', values, locale)];
}

/** One config write of the terminal (T3 L2 service write port; the `/config` panel of L4 binds it): principal'd through `resolveConfigPrincipal`, approval-aware. */
export interface ConfigWriteRequest {
  readonly action: 'set' | 'unset'; readonly keyPath: string; readonly value?: unknown; readonly layer?: 'project' | 'global';
  readonly scopeId: string; readonly commandId?: string; readonly expect?: string | null;
}
export async function configWrite(root: string, request: ConfigWriteRequest, context: ConfigCommandContext, options: ConfigLoadOptions): Promise<ConfigChangeOutcome> {
  if (!context.configApplication || !context.resolveConfigPrincipal) throw ErrorRegistry.createError('CLI_USAGE');
  const principal = await context.resolveConfigPrincipal(root, request.scopeId, options);
  const input = { keyPath: request.keyPath, layer: request.layer ?? 'project' as const, principal, scopeId: request.scopeId, commandId: request.commandId ?? randomUUID(),
    ...(request.expect === undefined ? {} : { expect: request.expect }) };
  return context.configApplication(root, options).submit(request.action, request.action === 'set' ? { ...input, value: request.value } : input);
}
/**
 * Pending terminal writes of this process: the same `/config set|unset` typed again resubmits the command whose approval is pending (same command
 * id and previewed digest), so an allow applies it; a terminal outcome (applied, denied, expired, stale) forgets it and the next attempt is a new
 * command. Bounded display state, never authority — the engine verifies every resubmission.
 */
const pendingWrites = new Map<string, { readonly commandId: string; readonly expect: string | null }>();
const PENDING_WRITES_KEPT = 32;

/** One terminal config write (`/config set|unset`, `/config key=value`, the `/config` panel, T3 L4): the principal'd port with the pending-command memory. */
export async function terminalConfigWrite(root: string, request: Omit<ConfigWriteRequest, 'scopeId' | 'commandId'>, context: ConfigCommandContext, options: ConfigLoadOptions,
  locale: Locale): Promise<{ readonly status: ConfigChangeOutcome['status']; readonly lines: readonly string[]; readonly approvalId: string | null }> {
  const scopeId = ((await loadConfig(root, options))['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  const layer = request.layer ?? 'project';
  const key = JSON.stringify([root, scopeId, request.action, layer, request.keyPath, request.value ?? null]), pending = pendingWrites.get(key);
  let outcome: ConfigChangeOutcome;
  try { outcome = await configWrite(root, { ...request, layer, scopeId, ...(pending ? { commandId: pending.commandId, expect: pending.expect } : {}) }, context, options); }
  catch (error) { pendingWrites.delete(key); throw error; }
  if (outcome.status === 'approval-pending') {
    pendingWrites.delete(key); pendingWrites.set(key, { commandId: outcome.commandId, expect: outcome.expect });
    while (pendingWrites.size > PENDING_WRITES_KEPT) pendingWrites.delete(pendingWrites.keys().next().value!);
    return { status: outcome.status, lines: renderConfigPending(outcome, locale, 'terminal'), approvalId: outcome.approval.approvalId };
  }
  pendingWrites.delete(key);
  const field = await context.configApplication!(root, options).explain({ keyPath: request.keyPath });
  return { status: outcome.status, lines: renderConfigChanged(request.keyPath, layer, field.apply, outcome.result, null, locale), approvalId: outcome.approvalId };
}

/** `/config key=value` (T3 L4 shortcut): the key's schema reads the text (the text itself, else its JSON); the project layer is written. */
export function configShortcut(args: string): { readonly keyPath: string; readonly text: string } | null {
  const match = /^([A-Za-z0-9_.-]+)=(.*)$/su.exec(args.trim());
  return match ? { keyPath: match[1]!, text: match[2]!.trim() } : null;
}

/** Terminal `/config [key]` view, `/config set <key> <json>` / `/config unset <key>` and `/config key=value` through the principal'd write port (project layer). */
export async function configSlash(root: string, args: string, context: ConfigCommandContext, options: ConfigLoadOptions, locale: Locale, width: number): Promise<readonly string[]> {
  const words = args.trim().split(/\s+/).filter(Boolean), [verb, keyPath] = words;
  if (!context.configApplication) return [t('config.surface.slashUsage', {}, locale)];
  const shortcut = configShortcut(args);
  if (verb === 'set' || verb === 'unset' || shortcut) {
    // A surface composed without the principal'd write route (an embedding, a test harness) stays read only, and says so.
    if (!context.resolveConfigPrincipal) return [t('config.surface.slashReadOnly', {}, locale)];
    if (shortcut) {
      const parsed = parseConfigInput(shortcut.keyPath, shortcut.text);
      if (!parsed.ok) return [t('config.surface.shortcutInvalid', { key: shortcut.keyPath }, locale)];
      return (await terminalConfigWrite(root, { action: 'set', keyPath: shortcut.keyPath, value: parsed.value }, context, options, locale)).lines;
    }
    if (!keyPath || (verb === 'set' ? words.length < 3 : words.length !== 2)) return [t('config.surface.slashUsage', {}, locale)];
    let value: unknown;
    if (verb === 'set') { try { value = JSON.parse(args.trim().slice(verb.length).trimStart().slice(keyPath.length).trim()); } catch { return [t('config.surface.slashUsage', {}, locale)]; } }
    return (await terminalConfigWrite(root, { action: verb as 'set' | 'unset', keyPath, value }, context, options, locale)).lines;
  }
  if (words.length > 1) return [t('config.surface.slashUsage', {}, locale)];
  const view = await context.configApplication(root, options).inspect(verb ? { keyPath: verb } : {});
  return renderConfigInspection(view, locale, width).split('\n');
}

/** Interactive TTY adapter: typed arguments never reach either parser or submit, including TERM=dumb fallback. */
export function configTtySlash(root: string, _args: string, context: ConfigCommandContext, options: ConfigLoadOptions, locale: Locale, width: number): Promise<readonly string[]> {
  return configSlash(root, '', context, options, locale, width);
}
