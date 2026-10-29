import { randomUUID } from 'node:crypto';
import { ErrorRegistry, PACKAGE_NAME } from '#platform/index.js';
import { configDisplayView, getConfigValue, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { emit, formatValue } from '#platform/index.js';
import { isSensitiveConfigKey, MESSAGE_REGISTRY, redactSensitive, resolveLocale, t, type Locale } from '#platform/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import { configServiceState, configWriteOperation, isProtectedConfigWrite, parseConfigInput, type ConfigApplication, type ConfigChangeOutcome, type ConfigFieldView, type DescribeService } from '#engine/index.js';
import { commandLocale, type CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { askCliCard, cliMode, cliTableStyle } from '#surfaces/core/cli-human/index.js';
import { applyOperationsBaseline, operationsBaselineOffer, registersOperations, type OwnerBaselineOpener } from './operations-baseline.js';
import { applyWord, renderConfigExplanation, renderConfigInspection, schemaWord, sourceWord } from './render.js';
import { configValueModel } from './choices.js';
import { configChoiceWords, narrowConfigPanel, renderConfigKeyList, renderConfigLeaves, renderConfigOverrides, type ConfigPanelOpener } from './cli-view.js';

export type ConfigApplicationFactory = (root: string, options: ConfigLoadOptions) => ConfigApplication;
export interface ConfigCommandContext extends CliBaseContext {
  configChoiceSources?: (root: string, options: ConfigLoadOptions) => import('./choices.js').ConfigChoiceSourcePort;
  configApplication?: ConfigApplicationFactory;
  loadInstallationIdentity?: (root: string, options: ConfigLoadOptions) => Promise<unknown>;
  /** Read-only service describe: a restart-apply change is compared with what the running service started with. */
  describeRuntimeService?: DescribeService;
  resolveConfigPrincipal?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<VerifiedPrincipal>;
  /** C-SETUP: the `/config` window on a person's terminal (bare `deckent config`, `config set <key>` without a value). */
  openConfigPanel?: ConfigPanelOpener;
  /** BeUser ZEY-02: the installer's founder-baseline preview/apply, offered after a person registers operations (person terminal only). */
  openOwnerBaselineInstallation?: OwnerBaselineOpener;
}
interface Parsed { readonly args: string[]; json: boolean; global: boolean; help: boolean; verbose: boolean; language?: string; expect?: string; scope?: string; commandId?: string }
function parse(argv: readonly string[]): Parsed {
  const result: Parsed = { args: [], json: false, global: false, help: false, verbose: false };
  const valued = { '--lang': 'language', '--expect': 'expect', '--scope': 'scope', '--command-id': 'commandId' } as const;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' || arg === '--global' || arg === '--help' || arg === '-h' || arg === '--verbose') {
      const key = arg === '--json' ? 'json' : arg === '--global' ? 'global' : arg === '--verbose' ? 'verbose' : 'help'; if (result[key]) throw ErrorRegistry.createError('CLI_USAGE'); result[key] = true;
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
  // L-KIT: one language per call (flag, environment, config `language`, system); the host already read config, so `explain`/`validate` follow it too.
  let locale = commandLocale(context, parsed.language);
  const relocale = (language: unknown) => {
    if (!parsed.language && !context.locale) { locale = resolveLocale(undefined, env, typeof language === 'string' ? language : undefined); context.onLocale?.(locale); }
  };
  const sinks = { json: parsed.json, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const action = parsed.args[0], keyPath = parsed.args[1], isWrite = action === 'set' || action === 'unset';
  const options: ConfigLoadOptions = { env, heal: false, onWarning: warning => emit(warning, { ...sinks, level: 'warning', render: value => value.message }) };
  const style = () => cliTableStyle(context), person = () => cliMode(context, parsed.json).mode === 'interactive';
  if (parsed.help) { emit(t('config.surface.help', {}, locale), { ...sinks, json: false }); return; }
  // BeUser E-11: name the flag and say it belongs to set/unset, instead of a bare "invalid arguments".
  if (!isWrite && (parsed.expect || parsed.scope || parsed.commandId)) throw ErrorRegistry.createError('CLI_USAGE', { locale, params: { command: [PACKAGE_NAME, argv[0], action].filter(Boolean).join(' '),
    flag: parsed.scope ? '--scope' : parsed.expect ? '--expect' : '--command-id', usage: t('config.surface.writeOnlyFlag', {}, locale) } });
  if (parsed.verbose && action !== 'explain') throw ErrorRegistry.createError('CLI_USAGE');
  // alpha.55.1: a write of a protected root is refused off a person's terminal before anything is read (`set <key>` alone writes nothing).
  if (isWrite && keyPath && parsed.args.length === (action === 'set' ? 3 : 2)) assertConfigPerson(context, action as 'set' | 'unset', keyPath, parsed.json);
  if (action === 'get') {
    if (parsed.args.length > 2) throw ErrorRegistry.createError('CLI_USAGE');
    const config = await loadConfig(root, { ...options, heal: true, globalOnly: parsed.global });
    relocale(config.language);
    // Config owns its bootstrap fence, recovery lock and warnings. Identity observation follows that load,
    // so the dispatcher's non-healing language/identity probe cannot preempt recovery or inspect project for --global.
    await context.loadInstallationIdentity?.(root, { env, heal: false, globalOnly: parsed.global });
    const display = configDisplayView(config);
    let value: unknown;
    try { value = keyPath === undefined ? display : getConfigValue(display, keyPath); }
    catch (error) {
      // An optional section (inference_serving, operations, ...) the registry declares but this installation leaves out is "not defined", not unknown.
      if (keyPath === undefined || !context.configApplication) throw error;
      let field: ConfigFieldView;
      try { field = await context.configApplication(root, { ...options, globalOnly: parsed.global }).explain({ keyPath }); } catch { throw error; }
      if (field.defaultValue !== undefined) {
        emit(field.defaultValue, { ...sinks, mode: config.output_mode, render: data => t('config.surface.effectiveDefault', { key: keyPath, value: formatValue(data), source: sourceWord('default', locale) }, locale) }); return;
      }
      emit(null, { ...sinks, mode: config.output_mode, render: () => t('clisetup.config.undefined', { key: keyPath }, locale) }); return;
    }
    // A person reads a group as rows (one per leaf, cut to the width); JSON and a single value keep the compatible output.
    const grouped = !parsed.json && config.output_mode !== 'json' && value !== null && typeof value === 'object';
    emit(value, { ...sinks, mode: config.output_mode, render: grouped ? data => renderConfigLeaves(data, keyPath ?? '', locale, style()) : formatValue }); return;
  }
  await context.loadInstallationIdentity?.(root, { env, heal: false, globalOnly: parsed.global });
  if (!context.configApplication) throw ErrorRegistry.createError('CLI_USAGE', { params: { usage: t('config.surface.unavailable', {}, locale) } });
  const app = context.configApplication(root, { ...options, globalOnly: parsed.global && !isWrite }), layer = parsed.global ? 'global' as const : 'project' as const;
  if (action === undefined && parsed.args.length === 0) {
    // A person on a terminal gets the terminal's own `/config` window (one implementation); everyone else the overrides summary.
    if (!parsed.json && !parsed.global && context.openConfigPanel && person()) { await openPanel(context, root, options, locale, null, sinks); return; }
    const view = await app.inspect({ layer });
    relocale(view.fields.find(field => field.key === 'language')?.value);
    emit(view, { ...sinks, render: value => renderConfigOverrides(value, locale, style()) }); return;
  }
  if (action === 'explain' && parsed.global) throw ErrorRegistry.createError('CLI_USAGE');
  if (action === 'explain' && parsed.args.length === 1) {
    const view = await app.inspect({});
    emit(view.fields.map(field => ({ key: field.key, description: describe(field, locale) })), { ...sinks,
      render: () => renderConfigKeyList(view.fields, field => describe(field, locale), locale, style()) }); return;
  }
  if (action === 'explain' && keyPath && parsed.args.length === 2) {
    emit(await app.explain({ keyPath }), { ...sinks, render: value => renderConfigExplanation(value, locale, 80, parsed.verbose) }); return;
  }
  if (action === 'validate' && parsed.args.length === 1) { emit(await app.validate(), { ...sinks, render: () => t('config.surface.valid', {}, locale) }); return; }
  if (action === 'set' && keyPath && parsed.args.length === 2) {
    // A value is chosen, never typed, by a person (owner 10-08): the window narrowed to this key; off a terminal the refusal lists what it takes.
    if (!parsed.json && !parsed.global && context.openConfigPanel && person()) { await openPanel(context, root, options, locale, keyPath, sinks); return; }
    throw await valueMissing(context, root, options, locale, keyPath);
  }
  if (!isWrite || !keyPath || parsed.args.length !== (action === 'set' ? 3 : 2)) throw ErrorRegistry.createError('CLI_USAGE');
  let value: unknown;
  // BeUser KER-05: a value that is not JSON names the key, what it takes and the quoting, never a bare usage error.
  if (action === 'set') { try { value = JSON.parse(parsed.args[2]!); } catch { throw await valueMissing(context, root, options, locale, keyPath, 'CLI_CONFIG_VALUE_NOT_JSON'); } }
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
  if (!parsed.json && registersOperations(keyPath) && person()) await offerOperationsBaseline(context, root, options, locale, sinks);
}
/** BeUser ZEY-02: after registering operations the person who lacks their cells gets the founder-baseline card at once (the installer's own plan). */
async function offerOperationsBaseline(context: ConfigCommandContext, root: string, options: ConfigLoadOptions, locale: Locale,
  sinks: { stdout?: import('#platform/index.js').OutputSink; stderr?: import('#platform/index.js').OutputSink }) {
  const offer = await operationsBaselineOffer(root, context.openOwnerBaselineInstallation, options, locale);
  if (!offer) return;
  const ttlMs = (await loadConfig(root, options)).approvals.sessionTtlMs;
  const answer = await askCliCard({ title: offer.title, body: [...offer.lines], options: [{ id: 'apply', label: t('cli.init.policyModes.cardApply', {}, locale), key: 'y' },
    { id: 'no', label: t('cli.init.policyModes.cardNo', {}, locale), key: 'n' }] }, { locale, env: context.env ?? process.env, signal: AbortSignal.timeout(ttlMs) });
  const lines = answer === 'apply' ? await applyOperationsBaseline(root, context.openOwnerBaselineInstallation!, offer, locale) : [offer.later];
  emit(lines.join('\n'), { ...sinks, json: false });
}
/**
 * alpha.55.1 (functest B P1): a write that changes a protected root (`isProtectedConfigWrite`: the AI floor's security roots and core-layer switches)
 * is a person's act at a terminal, the same refusal as the other person-only commands (`memory`, `agents`, `models login`): an AI marker, CI,
 * `TERM=dumb`, a pipe or `--json` is refused with `AUTHORITY_WITNESS_REQUIRED` here; the composed write path then asks the terminal witness.
 */
function assertConfigPerson(context: ConfigCommandContext, action: 'set' | 'unset', keyPath: string, json = false) {
  if (isProtectedConfigWrite(keyPath) && cliMode(context, json).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: configWriteOperation(action, keyPath) } });
}
const describe = (field: ConfigFieldView, locale: Locale) => (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[field.descriptionKey] ?? field.description;
/**
 * Whether a chosen value may be printed back: never when the config views redact it — the key's field view is redacted (secret provenance),
 * a path segment names a credential, or the value is a `$DECK:`/`$ENV:` reference or carries a credential pattern (the engine's field-view rule).
 */
async function chosenValueShown(context: ConfigCommandContext, root: string, options: ConfigLoadOptions, keyPath: string, value: unknown): Promise<boolean> {
  if (keyPath.split('.').some(isSensitiveConfigKey)) return false;
  try { if ((await context.configApplication!(root, options).explain({ keyPath })).redacted) return false; } catch { return false; }
  const strings: string[] = [], visit = (item: unknown, key = ''): void => {
    if (key && isSensitiveConfigKey(key)) strings.push('\u0000');
    if (typeof item === 'string') strings.push(item);
    else if (Array.isArray(item)) item.forEach(child => visit(child));
    else if (item && typeof item === 'object') for (const [name, child] of Object.entries(item)) visit(child, name);
  };
  visit(value);
  return strings.every(text => text !== '\u0000' && !/^\$DECK:|^\$ENV:/u.test(text) && redactSensitive(text) === text);
}
/** `config set <key>` without a value off a terminal (or with one that is not JSON): exit 2, naming the key and what it takes (its choices or schema). */
async function valueMissing(context: ConfigCommandContext, root: string, options: ConfigLoadOptions, locale: Locale, keyPath: string,
  code: 'CLI_CONFIG_VALUE_MISSING' | 'CLI_CONFIG_VALUE_NOT_JSON' = 'CLI_CONFIG_VALUE_MISSING') {
  const field = await context.configApplication!(root, options).explain({ keyPath });
  const model = await configValueModel(field, root, locale, context.configChoiceSources?.(root, options));
  // CONFIG-PARTIAL-CLI: a list its discovery cut short says so, and `--json` carries the cut (`partial`: time | size, `found`) beside the values.
  return ErrorRegistry.createError(code, { params: { key: keyPath, values: configChoiceWords(model.choices, schemaWord(field.schema, locale), locale),
    ...(model.partial ? { partial: model.partial.reason, found: model.partial.found } : {}) }, locale });
}
/** Opens the `/config` window (whole, or narrowed to one key) and prints what it left: its summaries, then an approval to decide. */
async function openPanel(context: ConfigCommandContext, root: string, options: ConfigLoadOptions, locale: Locale, keyPath: string | null,
  sinks: { stdout?: import('#platform/index.js').OutputSink; stderr?: import('#platform/index.js').OutputSink }) {
  const { configPanelPort } = await import('./panel.js');
  // Every write the window makes leaves its full outcome (a pending approval names the command that applies it); printed once the window closes.
  const written: string[] = [], keep = <T extends { readonly lines: readonly string[] }>(outcome: T) => { written.push(...outcome.lines); return outcome; };
  const base = configPanelPort(root, context, options, locale, undefined, 'cli'), records = base.records;
  const port = { ...base, write: async (request: Parameters<typeof base.write>[0]) => keep(await base.write(request)),
    records: { ...records, commit: async (token: string) => keep(await records.commit(token)) } };
  const pushed = await context.openConfigPanel!(keyPath ? narrowConfigPanel(port, keyPath) : port, { stdin: (context.stdin ?? process.stdin) as NodeJS.ReadStream,
    stdout: (context.stdout ?? process.stdout) as NodeJS.WriteStream, env: context.env ?? process.env, locale, ...(context.signal ? { signal: context.signal } : {}) });
  const lines = written.length ? written : pushed;
  if (lines.length) emit(lines.join('\n'), { ...sinks, json: false });
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
  assertConfigPerson(context, request.action, request.keyPath);
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
  locale: Locale, surface: 'terminal' | 'cli' = 'terminal'): Promise<{ readonly status: ConfigChangeOutcome['status']; readonly lines: readonly string[]; readonly approvalId: string | null }> {
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
    // `deckent config` (C-SETUP) is one process: the window's pending memory ends with it, so the line names the exact command that applies it.
    // A value the config views redact is never echoed (security review of be23372e): the command shows `<value>` and says why.
    const shown = request.action === 'set' && surface === 'cli' && await chosenValueShown(context, root, options, request.keyPath, request.value);
    const lines = surface === 'terminal' ? renderConfigPending(outcome, locale, 'terminal') : [renderConfigPending(outcome, locale, 'cli')[0]!,
      t('clisetup.config.approvalApply', { action: request.action, key: request.keyPath, scope: scopeId, commandId: outcome.commandId, expect: outcome.expect ?? 'absent',
        value: request.action !== 'set' ? '' : shown ? ` '${JSON.stringify(request.value ?? null).replace(/'/gu, `'\\''`)}'` : ' <value>',
        layer: layer === 'global' ? ' --global' : '' }, locale), ...(request.action === 'set' && !shown ? [t('clisetup.config.valueHidden', {}, locale)] : [])];
    return { status: outcome.status, lines, approvalId: outcome.approval.approvalId };
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
    const written = await terminalConfigWrite(root, { action: verb as 'set' | 'unset', keyPath, value }, context, options, locale);
    // A typed line cannot hold a card: it names the founder-baseline step when the registered operations are not the person's yet (ZEY-02).
    const offer = written.status === 'applied' && registersOperations(keyPath) ? await operationsBaselineOffer(root, context.openOwnerBaselineInstallation, options, locale) : null;
    return offer ? [...written.lines, offer.later] : written.lines;
  }
  if (words.length > 1) return [t('config.surface.slashUsage', {}, locale)];
  const view = await context.configApplication(root, options).inspect(verb ? { keyPath: verb } : {});
  return renderConfigInspection(view, locale, width).split('\n');
}

/** Interactive TTY adapter: typed arguments never reach either parser or submit, including TERM=dumb fallback. */
export function configTtySlash(root: string, _args: string, context: ConfigCommandContext, options: ConfigLoadOptions, locale: Locale, width: number): Promise<readonly string[]> {
  return configSlash(root, '', context, options, locale, width);
}
